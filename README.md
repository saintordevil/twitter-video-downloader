# X/Twitter Video Downloader

A Tampermonkey userscript that adds a download button to X/Twitter video players and saves the best compatible media available from the page.

For HLS posts, it downloads the highest-bandwidth video rendition and its matching audio group, then builds a standard MP4 locally in the browser. If HLS is unavailable, it falls back to the best direct MP4 variant exposed by X.

## Highlights

- One-click download control on X/Twitter video players
- `Ctrl+Shift+D` shortcut for the most visible video
- Separate HLS video and audio download with local fMP4-to-MP4 transmuxing
- Direct MP4 fallback when a compatible HLS source is unavailable
- Real progress, cancellation, bounded retries, and `Retry-After` handling
- Multiple-video and quote-post cache entries keyed by media identity when available
- Automatic GitHub update and download URLs in the userscript metadata
- No external conversion server, analytics, or telemetry

## Version 5.2.0

This release fixes correctness and lifecycle problems in the old 5.1 implementation:

- Corrects MP4 movie and track matrices, width, height, and per-track durations.
- Corrects fragmented-MP4 `tfhd` flag parsing and applies `trun` data offsets.
- Rejects missing, truncated, invalid, or unsupported fragments instead of silently producing a partial MP4.
- Selects the audio rendition referenced by the chosen HLS variant's `AUDIO` group.
- Never attaches an unrelated audio group when a variant does not reference one.
- Aborts active Tampermonkey requests and retry waits when a download is cancelled.
- Prevents duplicate downloads for the same media.
- Refreshes an expired HLS URL once, then falls back to the best validated direct MP4 when available.
- Uses completion and failure callbacks for `GM_download` and reports unverified browser-anchor saves honestly.
- Validates API and media origins before retaining headers or requesting media.
- Retains only the authorization and CSRF fields needed for an on-page lookup, in memory only.
- Bounds the metadata cache, segment count, HLS assembly size, retries, and DOM scan cadence.
- Validates fragment track IDs, decode timestamps, MP4 box boundaries, and continuous per-track timelines.
- Uses media-key hints and stable player bindings before falling back to DOM order on multi-video posts.
- Adds a singleton lifecycle that restores patched page APIs and removes owned UI on teardown.
- Fixes invisible buttons intercepting player controls and improves keyboard, focus, progress, and toast accessibility.

## Requirements

- A current desktop browser with [Tampermonkey](https://www.tampermonkey.net/)
- Access to `https://x.com/*` or `https://twitter.com/*`

Development tests additionally require Node.js, `ffmpeg`, and `ffprobe` on `PATH`.

## Install

Open the [raw userscript](https://raw.githubusercontent.com/saintordevil/twitter-video-downloader/master/twitter-video-downloader.user.js), then confirm **Install** in Tampermonkey.

The metadata keeps the existing namespace so an installed copy updates in place. Version checks and future downloads use this repository's raw `master` URL.

## Usage

| Action | Control |
| --- | --- |
| Download one video | Hover or focus its player, then select **Download** |
| Download the most visible video | Press `Ctrl+Shift+D` outside an editable field |
| Cancel an HLS download | Select **Cancel** in the progress overlay |

Files use this pattern:

```text
twitter_{postId}_{resolution}.mp4
```

Tampermonkey uses a unique filename if a file with that name already exists.

## How it works

1. At `document-start`, the script observes X/Twitter's page-level `fetch` and `XMLHttpRequest` responses through the declared `unsafeWindow` capability.
2. It extracts validated `video_info` records and keeps up to 500 recent post entries in memory.
3. If the selected post has no fresh media record, it uses the current page's captured X GraphQL route when an authenticated session is available, then tries X's public syndication response as a fallback.
4. HLS master playlists are parsed by attribute, and the highest-bandwidth video variant is paired with the referenced audio `GROUP-ID`.
5. Playlist, init, and media requests use `GM_xmlhttpRequest` with status checks, 30-second timeouts, bounded exponential backoff, jitter, server `Retry-After` handling, validation, and cancellation.
6. Compatible video and audio fragments are validated for box boundaries, track identity, decode-time continuity, and declared sample bytes, then assembled into a standard MP4 with sample tables and 64-bit chunk offsets.
7. Tampermonkey saves the resulting Blob with completion and error callbacks. A browser-anchor fallback is used only when direct Blob saving is unavailable.

## Safety limits

| Limit | Value |
| --- | ---: |
| Cached post entries | 500 |
| HLS playlist segments | 5,000 per rendition |
| Concurrent segment requests | 6 |
| Media request attempts | 5 |
| Playlist request attempts | 3 |
| Request timeout | 30 seconds |
| In-tab HLS segment bytes | 1 GiB |

The 1 GiB limit is for downloaded HLS segment data, not peak renderer memory. MP4 assembly temporarily retains segments, sample tables, Blob parts, and the final Blob, so peak memory can be higher. Very large HLS posts fail with a visible error instead of risking an unbounded browser-tab allocation. A direct MP4 fallback is streamed by Tampermonkey when X exposes one.

## Supported and unsupported HLS

The in-browser transmuxer supports the separate, unencrypted fMP4 video and audio playlists currently used by ordinary X video posts. Each media fragment must contain one track fragment and one sample run.

The script deliberately rejects:

- encrypted HLS playlists
- media or init-segment byte ranges
- discontinuous playlists
- fragments with multiple track fragments or multiple sample runs
- changing init segments within one media playlist
- missing decode timestamps, mismatched track IDs, discontinuous timelines, media boxes, samples, or declared sample bytes

Failing these formats is intentional. Packaging an unsupported stream as a successful MP4 would create a corrupt or incomplete file.

## Cancellation note

Cancel aborts active `GM_xmlhttpRequest` handles, retry waits, queued segment work, and a Tampermonkey save operation. Final MP4 assembly is synchronous JavaScript, so the page cannot dispatch a cancel click during that brief CPU-bound step. Cancellation remains effective before assembly and while the file is being saved.

## Privacy

- No third-party converter or download server
- No analytics, telemetry, update beacon, or remote code dependency
- No cookies, headers, post IDs, signed media URLs, or response bodies written to logs
- Only the current authorization and CSRF values needed for an on-page metadata request are retained, in memory, and cleared on teardown
- Media requests are restricted to `video.twimg.com`; the public metadata fallback is restricted to `cdn.syndication.twimg.com`
- All console messages use the `[TwitterVideoDownloader]` prefix

The script can only download media the current browser session or X's public response already exposes. Respect creators' rights, X's rules, and applicable law.

## Compatibility notes

- X uses private web routes and generated UI markup that can change without notice.
- The highest-bandwidth compatible HLS rendition is selected. This is not a guarantee that X exposes the uploader's original file.
- A direct MP4 fallback can be lower quality and may not include audio.
- Some posts are protected, expired, live, encrypted, or use a media format this local transmuxer intentionally rejects.
- Browser download settings can still prompt for a location or alter the final filename.

## Development and verification

Run the deterministic test harness from the repository root:

```text
node --test tests/twitter-video-downloader.test.mjs
```

The harness checks metadata, URL allowlists, media extraction, HLS parsing, cancellation, retries, download callbacks, malformed-fragment failures, and a real generated video-plus-audio MP4. The generated MP4 is independently inspected with `ffprobe` for duration, dimensions, video, and audio streams.

## Project details

- Userscript: `X/Twitter Video Downloader`
- Version: `5.2.0`
- Author: [saintordevil](https://github.com/saintordevil)
- License: MIT

## License

Licensed under the [MIT License](LICENSE).
