import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE_PATH = resolve(TESTS_DIR, "..", "twitter-video-downloader.user.js");

const EXPORT_BLOCK = String.raw`
    globalThis.__TWITTER_VIDEO_DOWNLOADER_TEST_API__ = Object.freeze({
        SCRIPT_VERSION,
        getApprovedTwitterOrigin,
        isTwitterApiUrl,
        isAllowedMediaUrl,
        resolveMediaUrl,
        readVideoInfo,
        extractVideoUrls,
        getVideoInfoForElement,
        parseHlsAttributes,
        parseM3U8Master,
        parseM3U8Variant,
        captureTweetEndpoint,
        retryAfterMs,
        gmRequest,
        gmDownloadPromise,
        safeFilePart,
        validateSegment,
        parseTrackInfo,
        parseFragmentSamples,
        transmuxToMP4,
        fetchTweetVideoData,
        downloadHLS,
        runDownloadForPlayer,
        destroy,
        getCapturedTweetEndpoint: () => capturedTweetEndpoint,
        resetCapturedTweetEndpoint: () => { capturedTweetEndpoint = null; },
        getCapturedVideoRecord: tweetId => capturedVideos.get(tweetId) || null,
        clearCapturedVideos: () => capturedVideos.clear(),
        getActiveRequestHandleCount: () => activeRequestHandles.size,
    });
`;

function createDocumentStub() {
    const makeElement = tagName => ({
        tagName: String(tagName).toUpperCase(),
        nodeType: 1,
        style: {},
        children: [],
        isConnected: true,
        appendChild(child) { this.children.push(child); child.isConnected = true; return child; },
        removeChild(child) { this.children = this.children.filter(value => value !== child); child.isConnected = false; return child; },
        remove() { this.isConnected = false; },
        click() {},
        addEventListener() {},
        setAttribute(name, value) { this[name] = String(value); },
        removeAttribute(name) { delete this[name]; },
        getAttribute(name) { return this[name] ?? null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    });
    const body = {
        appendChild(child) { child.isConnected = true; return child; },
        removeChild(child) { child.isConnected = false; return child; },
        querySelectorAll() { return []; },
    };

    return {
        readyState: "loading",
        nodeType: 9,
        cookie: "",
        body,
        activeElement: null,
        addEventListener() {},
        querySelectorAll() { return []; },
        getElementById() { return null; },
        createElement: makeElement,
    };
}

class FakeXMLHttpRequest {
    open() {}
    send() {}
    setRequestHeader() {}
    addEventListener() {}
}

class FakeMutationObserver {
    observe() {}
    disconnect() {}
}

function makeFixedDate(now) {
    return class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length === 0 ? [now] : args));
        }

        static now() {
            return now;
        }
    };
}

function silentConsole() {
    return {
        log() {},
        warn() {},
        error() {},
    };
}

export function parseUserscriptMetadata(source) {
    const block = source.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/u)?.[0];
    assert.ok(block, "userscript metadata block is missing");

    const metadata = new Map();
    for (const line of block.split(/\r?\n/u)) {
        const match = line.match(/^\/\/\s+@(\S+)(?:\s+(.*))?$/u);
        if (!match) continue;
        const values = metadata.get(match[1]) || [];
        values.push((match[2] || "").trim());
        metadata.set(match[1], values);
    }
    return metadata;
}

/**
 * Evaluates an in-memory instrumented copy of the userscript. No production file
 * is changed. Callers may provide network adapters for a separately authorized
 * live canary and call api.fetchTweetVideoData or api.downloadHLS. Do not log raw
 * responses or signed media URLs from those adapters.
 */
export function loadUserscriptHarness({
    sourcePath = DEFAULT_SOURCE_PATH,
    gmXmlhttpRequest = () => { throw new Error("Unexpected GM_xmlhttpRequest in offline harness"); },
    gmDownload,
    fetchImpl = async () => { throw new Error("Unexpected fetch in offline harness"); },
    consoleImpl = silentConsole(),
    locationHref = "https://x.com/home",
    now = Date.parse("2026-01-01T00:00:00Z"),
} = {}) {
    const source = readFileSync(sourcePath, "utf8");
    const closingPattern = /\r?\n\}\)\(\);\s*$/u;
    assert.match(source, closingPattern, "userscript IIFE closing marker was not found");
    const instrumentedSource = source.replace(closingPattern, `${EXPORT_BLOCK}\n})();`);

    const location = new URL(locationHref);
    const pageWindow = {
        fetch: fetchImpl,
        XMLHttpRequest: FakeXMLHttpRequest,
        location,
        addEventListener() {},
        matchMedia() { return { matches: false }; },
        innerWidth: 1280,
        innerHeight: 720,
    };
    const document = createDocumentStub();
    const sandbox = {
        window: pageWindow,
        unsafeWindow: pageWindow,
        document,
        location,
        GM_xmlhttpRequest: gmXmlhttpRequest,
        GM_download: gmDownload,
        MutationObserver: FakeMutationObserver,
        Node: { ELEMENT_NODE: 1 },
        AbortController,
        AbortSignal,
        Blob,
        URL,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
        DataView,
        Date: makeFixedDate(now),
        performance,
        console: consoleImpl,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 0),
        cancelAnimationFrame: clearTimeout,
    };

    const context = vm.createContext(sandbox, { name: "twitter-video-downloader-tests" });
    vm.runInContext(instrumentedSource, context, {
        filename: sourcePath,
        timeout: 5_000,
    });

    const api = context.__TWITTER_VIDEO_DOWNLOADER_TEST_API__;
    assert.ok(api, "instrumented userscript did not expose its test API");
    return { api, context, source, metadata: parseUserscriptMetadata(source) };
}
