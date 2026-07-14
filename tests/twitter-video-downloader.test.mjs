import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { loadUserscriptHarness } from "./userscript-harness.mjs";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = Date.parse("2026-01-01T00:00:00Z");

function metadataValues(metadata, key) {
    return metadata.get(key) || [];
}

function sorted(values) {
    return [...values].sort((a, b) => a.localeCompare(b));
}

function toArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function makeBox(type, payload = Buffer.alloc(0)) {
    const box = Buffer.alloc(8 + payload.length);
    box.writeUInt32BE(box.length, 0);
    box.write(type, 4, 4, "ascii");
    payload.copy(box, 8);
    return box;
}

function shiftFragmentDecodeTime(arrayBuffer, delta) {
    const buffer = Buffer.from(arrayBuffer.slice(0));
    const typeOffset = buffer.indexOf(Buffer.from("tfdt", "ascii"));
    assert.ok(typeOffset >= 4, "fixture fragment must contain tfdt");
    const version = buffer[typeOffset + 4];
    const valueOffset = typeOffset + 8;
    if (version === 0) {
        buffer.writeUInt32BE(buffer.readUInt32BE(valueOffset) + delta, valueOffset);
    } else if (version === 1) {
        buffer.writeBigUInt64BE(buffer.readBigUInt64BE(valueOffset) + BigInt(delta), valueOffset);
    } else {
        throw new Error(`unsupported fixture tfdt version ${version}`);
    }
    return toArrayBuffer(buffer);
}

function runTool(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const details = String(result.stderr || result.stdout || "no diagnostic output").trim();
        throw new Error(`${command} exited with ${result.status}: ${details}`);
    }
    return result.stdout;
}

function generateFmp4HlsFixtures(tempDir) {
    runTool("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
        "-map", "0:v:0", "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-threads", "1",
        "-flags:v", "+bitexact", "-metadata", "creation_time=1970-01-01T00:00:00Z",
        "-f", "hls", "-hls_time", "1", "-hls_list_size", "0",
        "-hls_playlist_type", "vod", "-hls_flags", "independent_segments",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "video-init.mp4",
        "-hls_segment_filename", "video-%03d.m4s", "video.m3u8",
    ], { cwd: tempDir });

    runTool("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=2",
        "-map", "0:a:0", "-vn",
        "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2",
        "-flags:a", "+bitexact", "-metadata", "creation_time=1970-01-01T00:00:00Z",
        "-f", "hls", "-hls_time", "1", "-hls_list_size", "0",
        "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "audio-init.mp4",
        "-hls_segment_filename", "audio-%03d.m4s", "audio.m3u8",
    ], { cwd: tempDir });
}

async function loadHlsFixture(api, tempDir, name) {
    const playlist = await readFile(join(tempDir, `${name}.m3u8`), "utf8");
    const parsed = api.parseM3U8Variant(playlist, `https://video.twimg.com/test-fixtures/${name}.m3u8`);
    assert.ok(parsed.initSegmentUrl, `${name} fixture must declare an init segment`);
    assert.ok(parsed.segments.length > 0, `${name} fixture must contain media segments`);

    const initBuffer = await readFile(join(tempDir, basename(new URL(parsed.initSegmentUrl).pathname)));
    const segments = [];
    for (const segmentUrl of parsed.segments) {
        const segment = await readFile(join(tempDir, basename(new URL(segmentUrl).pathname)));
        segments.push(toArrayBuffer(segment));
    }

    return { init: toArrayBuffer(initBuffer), segments };
}

test("metadata grants, hosts, version, and update URLs stay aligned", () => {
    const { api, metadata } = loadUserscriptHarness();

    assert.deepEqual(metadataValues(metadata, "name"), ["X/Twitter Video Downloader"]);
    assert.deepEqual(metadataValues(metadata, "version"), ["5.2.0"]);
    assert.equal(api.SCRIPT_VERSION, "5.2.0");
    assert.equal(metadataValues(metadata, "version")[0], api.SCRIPT_VERSION);
    assert.deepEqual(sorted(metadataValues(metadata, "grant")), sorted([
        "GM_download",
        "GM_xmlhttpRequest",
        "unsafeWindow",
    ]));
    assert.deepEqual(sorted(metadataValues(metadata, "connect")), sorted([
        "video.twimg.com",
        "cdn.syndication.twimg.com",
    ]));

    const releaseUrl = "https://raw.githubusercontent.com/saintordevil/twitter-video-downloader/master/twitter-video-downloader.user.js";
    assert.deepEqual(metadataValues(metadata, "updateURL"), [releaseUrl]);
    assert.deepEqual(metadataValues(metadata, "downloadURL"), [releaseUrl]);
    assert.deepEqual(sorted(metadataValues(metadata, "match")), sorted([
        "https://x.com/*",
        "https://twitter.com/*",
    ]));
    assert.deepEqual(metadataValues(metadata, "run-at"), ["document-start"]);
    assert.equal(metadata.has("noframes"), true);
});

test("master parser binds each variant to its AUDIO GROUP-ID even when media tags follow variants", () => {
    const { api } = loadUserscriptHarness();
    const master = [
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=800000,RESOLUTION=320x180,AUDIO=\"main-audio\"",
        "video/high/index.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,AUDIO=\"commentary\"",
        "video/low/index.m3u8",
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"commentary\",DEFAULT=YES,URI=\"audio/commentary.m3u8\"",
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"main-audio\",DEFAULT=NO,AUTOSELECT=YES,URI=\"../audio/main.m3u8\"",
    ].join("\n");

    const parsed = api.parseM3U8Master(master, "https://video.twimg.com/hls/master/index.m3u8");
    assert.equal(parsed.variants.length, 2);
    assert.equal(parsed.variants[0].resolution, "320x180");
    assert.equal(parsed.variants[0].url, "https://video.twimg.com/hls/master/video/high/index.m3u8");
    assert.equal(parsed.variants[0].audioPlaylistUrl, "https://video.twimg.com/hls/audio/main.m3u8");
    assert.equal(parsed.variants[1].audioPlaylistUrl, "https://video.twimg.com/hls/master/audio/commentary.m3u8");
    assert.equal(parsed.audioPlaylistUrl, "https://video.twimg.com/hls/audio/main.m3u8");
});

test("master parser never attaches an unrelated audio group", () => {
    const { api } = loadUserscriptHarness();
    const master = [
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=320x180",
        "video/index.m3u8",
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"commentary\",DEFAULT=YES,URI=\"audio/commentary.m3u8\"",
    ].join("\n");

    const parsed = api.parseM3U8Master(master, "https://video.twimg.com/hls/master.m3u8");
    assert.equal(parsed.variants.length, 1);
    assert.equal(parsed.variants[0].audioPlaylistUrl, null);
    assert.equal(parsed.audioPlaylistUrl, null);
});

test("relative media URLs resolve against their playlist", () => {
    const { api } = loadUserscriptHarness();
    const base = "https://video.twimg.com/hls/video/playlist.m3u8?case=relative";

    assert.equal(
        api.resolveMediaUrl("../segments/part-001.m4s?quality=best", base),
        "https://video.twimg.com/hls/segments/part-001.m4s?quality=best",
    );

    const parsed = api.parseM3U8Variant([
        "#EXTM3U",
        "#EXT-X-MAP:URI=\"init/init.mp4\"",
        "../segments/part-001.m4s",
        "part-002.m4s",
    ].join("\n"), base);
    assert.equal(parsed.initSegmentUrl, "https://video.twimg.com/hls/video/init/init.mp4");
    assert.deepEqual(Array.from(parsed.segments), [
        "https://video.twimg.com/hls/segments/part-001.m4s",
        "https://video.twimg.com/hls/video/part-002.m4s",
    ]);
});

test("playlist parsing rejects unapproved hosts and unsupported HLS features", () => {
    const { api } = loadUserscriptHarness();
    const base = "https://video.twimg.com/hls/playlist.m3u8";

    assert.throws(() => api.resolveMediaUrl("https://example.invalid/segment.m4s", base), /unapproved media host/u);
    assert.throws(() => api.resolveMediaUrl("https://video.twimg.com.evil.invalid/segment.m4s", base), /unapproved media host/u);
    assert.throws(() => api.resolveMediaUrl("http://video.twimg.com/segment.m4s", base), /unapproved media host/u);
    assert.throws(() => api.parseM3U8Variant([
        "#EXTM3U",
        "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
        "segment.m4s",
    ].join("\n"), base), /Encrypted HLS \(AES-128\) is not supported/u);
    assert.throws(() => api.parseM3U8Variant([
        "#EXTM3U",
        "#EXT-X-BYTERANGE:1000@0",
        "segment.m4s",
    ].join("\n"), base), /Byte-range HLS playlists are not supported/u);
    assert.throws(() => api.parseM3U8Variant([
        "#EXTM3U",
        "#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"1000@0\"",
        "segment.m4s",
    ].join("\n"), base), /Byte-range HLS init segments are not supported/u);
    assert.throws(() => api.parseM3U8Variant([
        "#EXTM3U",
        "#EXT-X-MAP:URI=\"init-one.mp4\"",
        "segment-1.m4s",
        "#EXT-X-MAP:URI=\"init-two.mp4\"",
        "segment-2.m4s",
    ].join("\n"), base), /Multiple HLS init segments are not supported/u);
    assert.throws(() => api.parseM3U8Variant([
        "#EXTM3U",
        "segment-1.m4s",
        "#EXT-X-DISCONTINUITY",
        "segment-2.m4s",
    ].join("\n"), base), /Discontinuous HLS playlists are not supported/u);
});

test("one tweet caches multiple distinct videos without collapsing them", () => {
    const { api } = loadUserscriptHarness();
    const tweetId = "123456789012345678";
    const payload = {
        __typename: "Tweet",
        rest_id: tweetId,
        legacy: {
            extended_entities: {
                media: [
                    {
                        media_key: "video-one",
                        video_info: {
                            variants: [
                                { content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/ext_tw_video/one/320x180/low.mp4" },
                                { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/ext_tw_video/one/320x180/high.mp4" },
                                { content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext_tw_video/one/pl/master.m3u8" },
                            ],
                        },
                    },
                    {
                        media_key: "video-two",
                        video_info: {
                            variants: [
                                { content_type: "video/mp4", bitrate: 512000, url: "https://video.twimg.com/ext_tw_video/two/320x180/video.mp4" },
                            ],
                        },
                    },
                ],
            },
        },
    };

    api.extractVideoUrls(payload);
    const record = JSON.parse(JSON.stringify(api.getCapturedVideoRecord(tweetId)));
    assert.ok(record);
    assert.equal(record.videos.length, 2);
    assert.equal(record.videos[0].mediaKey, "video-one");
    assert.equal(record.videos[0].mp4Variants[0].bitrate, 832000);
    assert.equal(record.videos[1].mediaKey, "video-two");
    assert.equal(record.videos[1].mp4Variants.length, 1);
});

test("player media hints bind a stable media key before DOM index fallback", () => {
    const tweetId = "123456789012345678";
    const { api } = loadUserscriptHarness({ locationHref: `https://x.com/example/status/${tweetId}` });
    api.extractVideoUrls({
        __typename: "Tweet",
        rest_id: tweetId,
        legacy: {
            extended_entities: {
                media: [
                    { media_key: "13_111111", video_info: { variants: [{ content_type: "video/mp4", bitrate: 1, url: "https://video.twimg.com/one.mp4" }] } },
                    { media_key: "13_222222", video_info: { variants: [{ content_type: "video/mp4", bitrate: 2, url: "https://video.twimg.com/two.mp4" }] } },
                ],
            },
        },
    });

    const article = { querySelectorAll: () => [player] };
    const mediaNode = {
        currentSrc: "blob:https://x.com/local-player",
        poster: "https://pbs.twimg.com/ext_tw_video_thumb/222222/player.jpg",
        getAttribute(name) { return name === "poster" ? this.poster : null; },
    };
    const player = {
        parentElement: null,
        querySelectorAll(selector) {
            if (selector === "video, source, img") return [mediaNode];
            if (selector.includes("/status/")) return [];
            return [];
        },
        closest(selector) {
            if (selector === "[data-testid=\"videoPlayer\"]") return this;
            if (selector === "article") return article;
            return null;
        },
    };

    const selected = api.getVideoInfoForElement(player);
    assert.equal(selected.tweetId, tweetId);
    assert.equal(selected.mediaKey, "13_222222");
    assert.equal(selected.mp4Variants[0].url, "https://video.twimg.com/two.mp4");
});

test("captured TweetResultByRestId endpoints require an approved HTTPS origin and exact path", () => {
    const { api } = loadUserscriptHarness();
    const path = "/i/api/graphql/Abc_123-Z/TweetResultByRestId";

    api.captureTweetEndpoint(`https://example.invalid${path}`);
    api.captureTweetEndpoint(`https://x.com.evil.invalid${path}`);
    api.captureTweetEndpoint(`http://x.com${path}`);
    api.captureTweetEndpoint(`https://x.com:444${path}`);
    api.captureTweetEndpoint("https://x.com/i/api/graphql/Abc_123-Z/TweetResultByRestId/extra");
    assert.equal(api.getCapturedTweetEndpoint(), null);

    api.captureTweetEndpoint(`https://x.com${path}?variables=ignored`);
    assert.equal(api.getCapturedTweetEndpoint(), `https://x.com${path}`);
    api.captureTweetEndpoint(`https://example.invalid${path}`);
    assert.equal(api.getCapturedTweetEndpoint(), `https://x.com${path}`);

    api.resetCapturedTweetEndpoint();
    api.captureTweetEndpoint("/i/api/graphql/Relative123/TweetResultByRestId?variables=ignored");
    assert.equal(api.getCapturedTweetEndpoint(), "https://x.com/i/api/graphql/Relative123/TweetResultByRestId");
    assert.equal(api.isTwitterApiUrl("https://twitter.com/i/api/1.1/statuses/show.json"), true);
    assert.equal(api.isTwitterApiUrl("https://twitter.com:444/i/api/1.1/statuses/show.json"), false);
    assert.equal(api.isTwitterApiUrl("https://x.com.evil.invalid/i/api/graphql/a/b"), false);
});

test("Retry-After parsing handles seconds, HTTP dates, invalid values, and past dates", () => {
    const { api } = loadUserscriptHarness({ now: FIXED_NOW });

    assert.equal(api.retryAfterMs("Retry-After: 1.25\r\n"), 1250);
    assert.equal(api.retryAfterMs("retry-after: Thu, 01 Jan 2026 00:00:03 GMT\r\n"), 3000);
    assert.equal(api.retryAfterMs("Retry-After: Wed, 31 Dec 2025 23:59:59 GMT\r\n"), 0);
    assert.equal(api.retryAfterMs("Retry-After: not-a-date\r\n"), 0);
    assert.equal(api.retryAfterMs("Content-Type: text/plain\r\n"), 0);
});

test("aborting a pending GM request aborts its handle and rejects once", async () => {
    let requestOptions = null;
    let abortCalls = 0;
    const { api } = loadUserscriptHarness({
        gmXmlhttpRequest(options) {
            requestOptions = options;
            return { abort() { abortCalls++; } };
        },
    });
    const controller = new AbortController();
    const pending = api.gmRequest("https://video.twimg.com/test/segment.m4s", {
        responseType: "arraybuffer",
        signal: controller.signal,
    });

    assert.ok(requestOptions);
    assert.equal(api.getActiveRequestHandleCount(), 1);
    controller.abort();
    await assert.rejects(pending, error => error?.name === "AbortError" && error?.message === "Cancelled");
    assert.equal(abortCalls, 1);
    assert.equal(api.getActiveRequestHandleCount(), 0);
    requestOptions.onload({ status: 200, response: new ArrayBuffer(8) });
    assert.equal(api.getActiveRequestHandleCount(), 0);
});

test("GM_download resolves its success callback and rejects its error callback", async () => {
    let successOptions = null;
    const successHarness = loadUserscriptHarness({
        gmDownload(options) {
            successOptions = options;
            return { abort() {} };
        },
    });
    const success = successHarness.api.gmDownloadPromise(
        "https://video.twimg.com/test/video.mp4",
        "twitter_123_320x180.mp4",
    );
    assert.equal(successOptions.name, "twitter_123_320x180.mp4");
    assert.equal(successOptions.conflictAction, "uniquify");
    assert.equal(successHarness.api.getActiveRequestHandleCount(), 1);
    successOptions.onload();
    const successResult = await success;
    assert.equal(successResult.completed, true);
    assert.equal(successResult.method, "gm-download");
    assert.equal(successHarness.api.getActiveRequestHandleCount(), 0);

    let errorOptions = null;
    const errorHarness = loadUserscriptHarness({
        gmDownload(options) {
            errorOptions = options;
            return { abort() {} };
        },
    });
    const failure = errorHarness.api.gmDownloadPromise(
        "https://video.twimg.com/test/video.mp4",
        "twitter_123_320x180.mp4",
    );
    errorOptions.onerror({ error: "not_permitted" });
    await assert.rejects(failure, error => error?.message === "Download failed (not_permitted)");
    assert.equal(errorHarness.api.getActiveRequestHandleCount(), 0);
});

test("filename components are sanitized, bounded, and given a fallback", () => {
    const { api } = loadUserscriptHarness();

    assert.equal(api.safeFilePart("  Hello / weird:* tweet  ", "fallback"), "Hello_weird_tweet");
    assert.equal(api.safeFilePart("日本語", "fallback"), "fallback");
    assert.equal(api.safeFilePart("___", "fallback"), "fallback");
    assert.equal(api.safeFilePart("x".repeat(120), "fallback"), "x".repeat(80));
    assert.equal(api.safeFilePart("valid-name_123.456", "fallback"), "valid-name_123.456");
});

test("malformed MP4 boxes, init data, and media fragments fail explicitly", () => {
    const { api } = loadUserscriptHarness();
    const truncatedStyp = Buffer.from([0, 0, 0, 16, 0x73, 0x74, 0x79, 0x70]);
    const validStypWithTrailingGarbage = Buffer.concat([makeBox("styp"), Buffer.from([0, 1, 2])]);
    const emptyMoof = makeBox("moof");
    const ftypOnly = makeBox("ftyp", Buffer.from("isom", "ascii"));

    assert.equal(api.validateSegment(new ArrayBuffer(0)), false);
    assert.equal(api.validateSegment(toArrayBuffer(truncatedStyp)), false);
    assert.equal(api.validateSegment(toArrayBuffer(validStypWithTrailingGarbage)), false);
    assert.throws(() => api.parseTrackInfo(toArrayBuffer(ftypOnly)), /No moov in init/u);
    assert.throws(
        () => api.parseFragmentSamples(toArrayBuffer(emptyMoof), { dur: 1, size: 1, flags: 0 }),
        /Expected one media data box|Expected one fragment track/u,
    );
    assert.throws(
        () => api.transmuxToMP4(toArrayBuffer(ftypOnly), null, [], [], () => {}),
        /No moov in init/u,
    );
});

test("non-authenticated metadata lookup uses the public syndication fallback", async () => {
    const tweetId = "123456789012345678";
    let requestCount = 0;
    const payload = {
        video_info: {
            variants: [
                { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/test/video.mp4" },
                { content_type: "application/x-mpegURL", url: "https://video.twimg.com/test/master.m3u8" },
            ],
        },
    };
    const { api } = loadUserscriptHarness({
        gmXmlhttpRequest(options) {
            requestCount++;
            options.onload({
                status: 200,
                responseText: JSON.stringify(payload),
                responseHeaders: "Content-Type: application/json",
            });
            return { abort() {} };
        },
    });

    const result = await api.fetchTweetVideoData(tweetId);
    assert.equal(requestCount, 1);
    assert.ok(result);
    assert.equal(result.mp4Variants.length, 1);
    assert.equal(result.m3u8Url, "https://video.twimg.com/test/master.m3u8");
});

test("an HLS failure falls through to the best direct MP4", async () => {
    const tweetId = "123456789012345678";
    let hlsRequests = 0;
    let directDownloads = 0;
    const { api } = loadUserscriptHarness({
        locationHref: `https://x.com/example/status/${tweetId}`,
        gmXmlhttpRequest(options) {
            hlsRequests++;
            options.onload({ status: 400, responseText: "", responseHeaders: "Content-Type: text/plain" });
            return { abort() {} };
        },
        gmDownload(options) {
            directDownloads++;
            options.onload();
            return { abort() {} };
        },
    });
    api.extractVideoUrls({
        __typename: "Tweet",
        rest_id: tweetId,
        legacy: {
            extended_entities: {
                media: [{
                    media_key: "13_333333",
                    video_info: {
                        variants: [
                            { content_type: "application/x-mpegURL", url: "https://video.twimg.com/test/failing-master.m3u8" },
                            { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/test/direct.mp4" },
                        ],
                    },
                }],
            },
        },
    });

    const article = { querySelectorAll: () => [player] };
    const player = {
        tagName: "DIV",
        nodeType: 1,
        parentElement: null,
        isConnected: true,
        style: {},
        appendChild(child) { child.isConnected = true; return child; },
        querySelector() { return null; },
        querySelectorAll(selector) { return selector.includes("/status/") ? [] : []; },
        closest(selector) {
            if (selector === "[data-testid=\"videoPlayer\"]") return this;
            if (selector === "article") return article;
            return null;
        },
    };

    await api.runDownloadForPlayer(player);
    assert.equal(hlsRequests, 1);
    assert.equal(directDownloads, 1);
    api.destroy("test-complete");
});

test("an expired quoted-player HLS URL refreshes the media-bound post once", async () => {
    const outerTweetId = "111111111111111111";
    const quotedTweetId = "222222222222222222";
    let refreshedTweetId = null;
    let hlsRequests = 0;
    let directDownloads = 0;
    const refreshedPayload = {
        media_key: "13_444444",
        video_info: {
            variants: [{ content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/test/refreshed-direct.mp4" }],
        },
    };
    const { api } = loadUserscriptHarness({
        locationHref: `https://x.com/example/status/${outerTweetId}`,
        gmXmlhttpRequest(options) {
            if (options.url.includes("cdn.syndication.twimg.com")) {
                refreshedTweetId = new URL(options.url).searchParams.get("id");
                options.onload({ status: 200, responseText: JSON.stringify(refreshedPayload), responseHeaders: "Content-Type: application/json" });
            } else {
                hlsRequests++;
                options.onload({ status: 403, responseText: "", responseHeaders: "Content-Type: text/plain" });
            }
            return { abort() {} };
        },
        gmDownload(options) {
            directDownloads++;
            options.onload();
            return { abort() {} };
        },
    });
    api.extractVideoUrls({
        __typename: "Tweet",
        rest_id: quotedTweetId,
        legacy: {
            extended_entities: {
                media: [{
                    media_key: "13_444444",
                    video_info: {
                        variants: [
                            { content_type: "application/x-mpegURL", url: "https://video.twimg.com/test/expired-master.m3u8" },
                            { content_type: "video/mp4", bitrate: 128000, url: "https://video.twimg.com/test/old-direct.mp4" },
                        ],
                    },
                }],
            },
        },
    });

    const article = { querySelectorAll: () => [player] };
    const mediaNode = {
        poster: "https://pbs.twimg.com/ext_tw_video_thumb/444444/player.jpg",
        getAttribute(name) { return name === "poster" ? this.poster : null; },
    };
    const player = {
        tagName: "DIV",
        nodeType: 1,
        parentElement: null,
        isConnected: true,
        style: {},
        appendChild(child) { child.isConnected = true; return child; },
        querySelector() { return null; },
        querySelectorAll(selector) {
            if (selector === "video, source, img") return [mediaNode];
            return [];
        },
        closest(selector) {
            if (selector === "[data-testid=\"videoPlayer\"]") return this;
            if (selector === "article") return article;
            return null;
        },
    };

    await api.runDownloadForPlayer(player);
    assert.equal(hlsRequests, 1);
    assert.equal(refreshedTweetId, quotedTweetId);
    assert.equal(directDownloads, 1);
    api.destroy("test-complete");
});

test("FFmpeg fMP4 fixtures transmux into a probed 320x180 MP4 with audio", { timeout: 120_000 }, async t => {
    const tempDir = await mkdtemp(join(TESTS_DIR, ".tmp-twitter-video-downloader-"));
    let completed = false;
    let summary = null;

    try {
        const fixtureStart = performance.now();
        generateFmp4HlsFixtures(tempDir);
        const fixtureMs = performance.now() - fixtureStart;
        const { api } = loadUserscriptHarness();
        const video = await loadHlsFixture(api, tempDir, "video");
        const audio = await loadHlsFixture(api, tempDir, "audio");

        assert.equal(api.validateSegment(video.segments[0]), true);
        assert.equal(api.validateSegment(audio.segments[0]), true);
        assert.throws(
            () => api.transmuxToMP4(video.init, null, [null], [], () => {}),
            /Missing media segment 1 of 1/u,
        );
        const audioInfo = api.parseTrackInfo(audio.init);
        const shiftedAudioSegments = audio.segments.map(segment => shiftFragmentDecodeTime(segment, audioInfo.timescale));
        assert.throws(
            () => api.transmuxToMP4(video.init, audio.init, video.segments, shiftedAudioSegments, () => {}),
            /Video and audio tracks begin at different decode times/u,
        );

        const progress = [];
        const transmuxStart = performance.now();
        const result = api.transmuxToMP4(
            video.init,
            audio.init,
            video.segments,
            audio.segments,
            (message, percent) => progress.push({ message, percent }),
        );
        const transmuxMs = performance.now() - transmuxStart;

        assert.equal(result.resolution, "320x180");
        assert.equal(result.hasAudio, true);
        assert.ok(result.totalSize > 10_000, `expected non-trivial MP4 size, got ${result.totalSize}`);
        assert.ok(progress.some(entry => entry.message === "Building standard MP4..." && entry.percent === 100));

        const outputPath = join(tempDir, "transmuxed.mp4");
        await writeFile(outputPath, Buffer.from(await result.blob.arrayBuffer()));
        assert.ok(existsSync(outputPath), "transmuxed MP4 was not written");

        const probeOutput = runTool("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=codec_type,width,height:format=duration,size",
            "-of", "json",
            outputPath,
        ]);
        const probe = JSON.parse(probeOutput);
        const duration = Number(probe.format?.duration);
        const videoStream = probe.streams?.find(stream => stream.codec_type === "video");
        const audioStream = probe.streams?.find(stream => stream.codec_type === "audio");

        assert.ok(Number.isFinite(duration), "ffprobe did not report a duration");
        assert.ok(duration >= 1.9 && duration <= 2.2, `unexpected MP4 duration ${duration}`);
        assert.ok(videoStream, "ffprobe did not find a video stream");
        assert.equal(videoStream.width, 320);
        assert.equal(videoStream.height, 180);
        assert.ok(audioStream, "ffprobe did not find an audio stream");
        assert.ok(Number(probe.format?.size) > 10_000, "ffprobe reported a trivial output size");

        summary = {
            duration,
            size: Number(probe.format.size),
            fixtureMs: Math.round(fixtureMs),
            transmuxMs: Math.round(transmuxMs),
        };
        completed = true;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }

    assert.equal(completed, true);
    assert.equal(existsSync(tempDir), false, "temporary fixture directory was not removed");
    t.diagnostic(`ffprobe duration=${summary.duration}s size=${summary.size} fixtureMs=${summary.fixtureMs} transmuxMs=${summary.transmuxMs}`);
});
