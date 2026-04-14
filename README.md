# Twitter Video Downloader

A [Tampermonkey](https://www.tampermonkey.net/) userscript that downloads videos from X/Twitter at the best available quality -- with full audio. Works on the home feed, status pages, search results, bookmarks, lists, and profiles.

## Features

- **One-Click Download** -- Hover over any video, click the Download button (top-right corner)
- **Best Quality via HLS** -- Downloads the highest resolution stream (1080p/720p) with separate audio, merged into a standard MP4
- **Full Audio Support** -- Captures and muxes the audio track that Twitter separates from the video stream
- **In-Browser fMP4 Transmuxer** -- Converts fragmented MP4 (HLS) segments into a standard playable MP4 entirely in the browser -- no server or ffmpeg needed
- **Progress Overlay** -- Real-time download progress with segment count, MB downloaded, and a cancel button
- **Concurrent Downloads** -- Fetches up to 6 segments in parallel for fast downloads
- **Automatic Retry** -- Failed segments are retried up to 5 times with backoff and validation
- **Keyboard Shortcut** -- Press `Ctrl+Shift+D` to download the most visible video on screen
- **Works Everywhere** -- Home feed, individual tweets, search, lists, bookmarks, profiles, quote tweets
- **MP4 Fallback** -- Falls back to direct MP4 download when HLS is unavailable
- **Syndication API Fallback** -- If the authenticated API fails, falls back to Twitter's public syndication API
- **Toast Notifications** -- Visual feedback for download status, file size, resolution, and errors

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser if you haven't already
2. Click **[here](../../raw/master/twitter-video-downloader.user.js)** to install the script -- Tampermonkey will prompt you automatically
3. Click **Install** in the Tampermonkey editor that opens

To install manually:

1. Open Tampermonkey > **Create a new script**
2. Delete the template, paste the contents of `twitter-video-downloader.user.js`
3. Save with `Ctrl+S`

## Usage

| Action | How |
|--------|-----|
| **Download** | Hover over any video > click the **Download** button (top-right) |
| **Quick download** | Press `Ctrl+Shift+D` to download the most visible video on screen |
| **Cancel** | Click **Cancel** on the progress overlay during an HLS download |

The script automatically intercepts API responses as you browse. If you navigate directly to a tweet, it will actively fetch the video data when you click Download.

## How It Works

### The Problem

X/Twitter serves videos through HLS (HTTP Live Streaming) using fragmented MP4 segments. The video and audio are delivered as separate streams, and the browser plays them via Media Source Extensions (blob URLs). You can't right-click and save these -- there's no single downloadable file.

### Network Interception

The script injects at `document-start` and hooks into `fetch` and `XMLHttpRequest` on the page's real `window` (via `unsafeWindow`, bypassing Tampermonkey's sandbox). As Twitter's app makes API calls, the script:

1. **Captures authentication** -- Grabs `authorization` and `x-csrf-token` headers from GraphQL/API requests
2. **Captures the GraphQL endpoint** -- Records the `TweetResultByRestId` URL (the hash in the path changes with Twitter updates)
3. **Extracts video data** -- Recursively walks API JSON responses to find `video_info.variants`, storing both M3U8 playlist URLs and direct MP4 URLs keyed by tweet ID

### Active API Fetch

When a video wasn't captured passively (e.g. direct navigation to a tweet), the script makes an authenticated `TweetResultByRestId` GraphQL call using the captured auth headers and endpoint. If that fails, it falls back to the unauthenticated syndication API (`cdn.syndication.twimg.com`).

### HLS Download & Transmux Pipeline

When an M3U8 URL is available, the script:

1. **Parses the master playlist** -- Identifies the highest-bandwidth video variant and the audio rendition
2. **Parses variant playlists** -- Extracts init segments and media segment URLs for both video and audio
3. **Downloads segments concurrently** -- Fetches up to 6 segments in parallel using `GM_xmlhttpRequest` (CORS bypass), with retry logic and fMP4 box validation
4. **Transmuxes to standard MP4** -- The in-browser transmuxer:
   - Parses the fMP4 init segments (`moov` box) to extract track info: timescale, codec config (`stsd`), dimensions, handler type, and `trex` defaults
   - Walks each media segment's `moof`/`trun` boxes to extract per-sample metadata (duration, size, flags, composition time offsets)
   - Builds a complete non-fragmented MP4 with proper `ftyp`, `moov` (containing `mvhd`, `trak`, `mdhd`, `hdlr`, `stbl` with `stts`/`stsz`/`stsc`/`stss`/`ctts`/`co64`), and a single `mdat` containing all video + audio sample data
   - Patches `co64` chunk offsets in-place after calculating final file layout
5. **Triggers download** -- Creates a Blob URL and saves the file as `twitter_{tweetId}_{resolution}.mp4`

### MP4 Fallback

If no M3U8 URL is found, the script downloads the highest-bitrate direct MP4 variant via `GM_download`. These are typically lower quality and may lack audio on newer tweets.

## Technical Details

- Runs at `document-start` to intercept network calls before Twitter's app initializes
- Uses `unsafeWindow` to hook the page's real `fetch`/`XHR` (not Tampermonkey's sandboxed copies)
- Hardcoded Twitter bearer token for unauthenticated fallback (same public token used by twitter.com itself)
- Full fMP4 box parser/writer with support for `moov`, `trak`, `mdia`, `mdhd` (v0/v1), `hdlr`, `stbl`, `trun`, `tfhd`, `trex`, `co64` (64-bit offsets), and extended-size `mdat`
- Validates downloaded segments by checking fMP4 box structure (`styp`/`moof`/`ftyp` first box)
- Handles retweets and quote tweets by scanning the full API response when the video is stored under a different tweet ID
- MutationObserver watches for DOM changes to add download buttons on infinite scroll and SPA navigation

## Console Logging

All log messages are prefixed with `[VidDL]` for easy filtering in DevTools. Key events logged:

- Script initialization and `unsafeWindow` availability
- Every intercepted fetch/XHR with URL
- Auth header and endpoint captures
- Video data extraction (M3U8 and MP4 variant counts per tweet)
- Active API fetch attempts and results
- HLS segment download progress
- Transmux details (track info, dimensions, timescale, chunk counts, duration)
- Errors and fallback attempts

## License

MIT
