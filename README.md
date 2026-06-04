# Twitter Video Downloader

X/Twitter video downloader for Tampermonkey: save the best available video with audio directly from the page.

Twitter serves many videos through HLS with separate audio and video streams, which prevents a normal right-click save from producing a complete MP4. This userscript captures video metadata while you browse, downloads the best stream it can access, and builds a standard MP4 in the browser without a server or ffmpeg.

## Core Behavior

| Feature | What it does | How |
|---|---|---|
| **One-Click Download** | Adds a download control to videos on X/Twitter | Hover a video and click **Download** |
| **Best Quality HLS** | Downloads the highest available HLS variant with audio | Parses M3U8 playlists and selects the best stream |
| **Audio Merge** | Produces a playable MP4 with video and audio together | Transmuxes separate fMP4 segments in the browser |
| **Progress Overlay** | Shows download status and supports cancellation | Tracks segment count, MB downloaded, and progress |
| **Fast Segment Fetching** | Downloads HLS segments quickly | Fetches up to 6 segments in parallel |
| **Retry Handling** | Retries failed segment downloads | Retries up to 5 times with backoff and segment validation |
| **MP4 Fallback** | Downloads a direct MP4 when HLS is unavailable | Uses the best direct MP4 variant found |
| **Syndication Fallback** | Tries a public fallback when authenticated API lookup fails | Uses Twitter's syndication API |
| **Toast Notifications** | Shows download status, file size, resolution, and errors | Displays browser-page toast messages |

## Supported Surfaces

| Surface | Support |
|---|---|
| **Home Feed** | Download buttons on feed videos |
| **Status Pages** | Direct tweet video downloads |
| **Search Results** | Video downloads while browsing search |
| **Bookmarks** | Video downloads from saved tweets |
| **Lists** | Video downloads inside list timelines |
| **Profiles** | Video downloads from profile timelines |
| **Quote Tweets** | Scans API responses for nested video data |

## Requirements

- A browser with [Tampermonkey](https://www.tampermonkey.net/)
- Access to `https://x.com/*` or `https://twitter.com/*`
- Tampermonkey permissions for `GM_download` and `GM_xmlhttpRequest`

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the raw userscript:

```bash
https://github.com/saintordevil/twitter-video-downloader/raw/master/twitter-video-downloader.user.js
```

3. Confirm **Install** in the Tampermonkey editor.

To install manually:

1. Open Tampermonkey > **Create a new script**.
2. Delete the template contents.
3. Paste the contents of `twitter-video-downloader.user.js`.
4. Save with `Ctrl+S`.

## Usage

| Action | How |
|---|---|
| **Download a video** | Hover over any video and click **Download** in the top-right corner |
| **Quick download** | Press `Ctrl+Shift+D` to download the most visible video on screen |
| **Cancel HLS download** | Click **Cancel** in the progress overlay |

The script passively captures video metadata as Twitter loads timeline and tweet API responses. If a direct tweet visit has not exposed the video yet, the script makes an authenticated `TweetResultByRestId` request using headers captured from the current page session, then falls back to the syndication API when needed.

Downloaded files use this pattern:

```bash
twitter_{tweetId}_{resolution}.mp4
```

## How It Works

Twitter commonly serves video through HLS using fragmented MP4 segments. Video and audio are delivered as separate streams, then played by the browser through Media Source Extensions. The userscript handles that pipeline locally:

1. Captures `fetch` and `XMLHttpRequest` calls from the page's real `window` through `unsafeWindow`.
2. Records authentication headers, CSRF headers, and the current `TweetResultByRestId` GraphQL endpoint.
3. Extracts `video_info.variants` from API responses and stores M3U8 plus direct MP4 URLs by tweet ID.
4. Parses the HLS master playlist and selects the highest-bandwidth video variant plus the audio rendition.
5. Downloads init segments and media segments with `GM_xmlhttpRequest`.
6. Validates fMP4 segment structure before accepting segment data.
7. Builds a standard MP4 with `ftyp`, `moov`, and `mdat` boxes, including video and audio sample data.
8. Saves the final Blob as an MP4 file.

## Technical Details

- Userscript name: `X/Twitter Video Downloader`
- Version: `5.1`
- Runs at `document-start`
- Matches `https://x.com/*` and `https://twitter.com/*`
- Uses `GM_download` and `GM_xmlhttpRequest`
- Connects to Twitter, X, API, syndication, video, and image hostnames declared in the userscript header
- Uses an in-browser fMP4 parser and writer for HLS transmuxing
- Supports `moov`, `trak`, `mdia`, `mdhd`, `hdlr`, `stbl`, `trun`, `tfhd`, `trex`, `co64`, and extended-size `mdat`
- Watches page changes with `MutationObserver` so download buttons appear during infinite scroll and SPA navigation

## Console Logging

All log messages use the `[VidDL]` prefix for filtering in DevTools.

Key logged events include script initialization, intercepted API requests, captured auth headers, endpoint discovery, video extraction, HLS segment progress, transmux details, download completion, errors, and fallback attempts.

## Privacy Notes

- Runs locally in the browser through Tampermonkey
- Does not use a separate download server
- Reads auth and CSRF headers from X/Twitter requests already made by the page
- Uses a public Twitter bearer token style fallback without documenting or exposing its value here
- Direct MP4 fallback can be lower quality and may lack audio on newer tweets

## License

MIT
