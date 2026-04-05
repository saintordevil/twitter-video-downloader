# Twitter Video Downloader

A [Tampermonkey](https://www.tampermonkey.net/) userscript that adds a download button to every video on X/Twitter — home feed, status pages, search results, and more.

## Features

- **Download Button** — Appears on hover over any video player (top-right corner)
- **Quality Picker** — Choose from available resolutions when multiple variants exist
- **Keyboard Shortcut** — Press `Ctrl+Shift+D` to download the most visible video on screen
- **Works Everywhere** — Home feed, individual tweets, search, lists, bookmarks, profiles
- **Toast Notifications** — Visual feedback for download status and errors

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser if you haven't already
2. Click **[here](../../raw/main/twitter-video-downloader.user.js)** to install the script — Tampermonkey will prompt you automatically
3. Click **Install** in the Tampermonkey editor that opens

To install manually:

1. Open Tampermonkey → **Create a new script**
2. Delete the template, paste the contents of `twitter-video-downloader.user.js`
3. Save with `Ctrl+S`

## Usage

| Action | How |
|--------|-----|
| **Download** | Hover over any video → click the **Download** button (top-right) |
| **Pick quality** | If multiple resolutions are available, a picker appears on click |
| **Quick download** | Press `Ctrl+Shift+D` to download the most visible video on screen |

> The video needs to have loaded or played at least once for the URL to be captured. If you land directly on a status page, play the video first — the script intercepts the URL as it loads.

## How It Works

X/Twitter serves videos through blob URLs created via Media Source Extensions, which can't be downloaded directly. This script intercepts `fetch` and `XMLHttpRequest` calls at page load to capture the real MP4 URLs from Twitter's API responses as they flow through the page.

Captured URLs are matched to specific tweets via tweet ID and video thumbnail path. If a URL wasn't captured from the feed (e.g. direct navigation to a tweet), the script falls back to Twitter's syndication API to resolve the video URL without authentication.

Downloads are handled through Tampermonkey's `GM_download` and `GM_xmlhttpRequest` APIs to bypass CORS restrictions on `video.twimg.com`.

## License

MIT
