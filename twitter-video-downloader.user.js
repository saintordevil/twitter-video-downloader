// ==UserScript==
// @name         X/Twitter Video Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Download videos from X/Twitter posts
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      video.twimg.com
// @connect      x.com
// @connect      twitter.com
// @connect      api.x.com
// @connect      api.twitter.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Store captured video URLs keyed by tweet ID or blob URL
    const capturedVideos = new Map();
    // Store all mp4 URLs we see
    const allMp4Urls = [];

    // --- Intercept fetch to capture video URLs from API responses ---
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            // Twitter API endpoints that return tweet/video data
            if (url.includes('/TweetDetail') ||
                url.includes('/TweetResultByRestId') ||
                url.includes('/HomeTimeline') ||
                url.includes('/HomeLatestTimeline') ||
                url.includes('/ListLatestTweetsTimeline') ||
                url.includes('/SearchTimeline') ||
                url.includes('/UserTweets') ||
                url.includes('/Likes') ||
                url.includes('/BookmarkTimeline') ||
                url.includes('/graphql/')) {
                const clone = response.clone();
                clone.json().then(json => extractVideoUrls(json)).catch(() => {});
            }
            // Direct m3u8/mp4 URLs
            if (url.includes('video.twimg.com') && url.includes('.mp4')) {
                trackMp4Url(url);
            }
        } catch (e) {}
        return response;
    };

    // --- Intercept XHR as fallback ---
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._url = url;
        return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', function () {
            try {
                const url = this._url || '';
                if (url.includes('video.twimg.com') && url.includes('.mp4')) {
                    trackMp4Url(url);
                }
                if (url.includes('/graphql/') || url.includes('TweetDetail') || url.includes('Timeline')) {
                    const json = JSON.parse(this.responseText);
                    extractVideoUrls(json);
                }
            } catch (e) {}
        });
        return originalSend.apply(this, args);
    };

    function trackMp4Url(url) {
        // Clean URL (remove query params for dedup, keep for download)
        const clean = url.split('?')[0];
        if (!allMp4Urls.find(u => u.split('?')[0] === clean)) {
            allMp4Urls.push(url);
        }
    }

    // Recursively extract video URLs from Twitter API JSON
    function extractVideoUrls(obj, tweetId = null) {
        if (!obj || typeof obj !== 'object') return;

        // Track tweet ID context
        if (obj.rest_id && typeof obj.rest_id === 'string') {
            tweetId = obj.rest_id;
        }
        if (obj.id_str && typeof obj.id_str === 'string') {
            tweetId = obj.id_str;
        }

        // Look for video_info which contains variants
        if (obj.video_info && obj.video_info.variants) {
            const variants = obj.video_info.variants
                .filter(v => v.content_type === 'video/mp4')
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

            if (variants.length > 0) {
                const best = variants[0];
                if (tweetId) {
                    capturedVideos.set(tweetId, {
                        url: best.url,
                        bitrate: best.bitrate,
                        allVariants: variants
                    });
                }
                trackMp4Url(best.url);
                // Also track all variants
                variants.forEach(v => trackMp4Url(v.url));
            }
        }

        // Recurse
        if (Array.isArray(obj)) {
            obj.forEach(item => extractVideoUrls(item, tweetId));
        } else {
            Object.values(obj).forEach(val => extractVideoUrls(val, tweetId));
        }
    }

    // --- Extract tweet ID from various URL patterns ---
    function getTweetIdFromUrl(url) {
        const match = url.match(/\/status\/(\d+)/);
        return match ? match[1] : null;
    }

    function getTweetIdFromElement(el) {
        // Walk up to find the tweet article or link with status URL
        let current = el;
        while (current && current !== document.body) {
            // Check for article with tweet
            if (current.tagName === 'ARTICLE') {
                const timeLink = current.querySelector('a[href*="/status/"] time');
                if (timeLink) {
                    const href = timeLink.closest('a').href;
                    return getTweetIdFromUrl(href);
                }
            }
            // Check for links
            const statusLinks = current.querySelectorAll?.('a[href*="/status/"]');
            if (statusLinks?.length) {
                for (const link of statusLinks) {
                    const id = getTweetIdFromUrl(link.href);
                    if (id) return id;
                }
            }
            current = current.parentElement;
        }
        // Fallback: check current page URL
        return getTweetIdFromUrl(window.location.href);
    }

    // --- Find best video URL for a given context ---
    function findVideoUrl(videoElement) {
        // 1. Try to get tweet ID and look up captured URL
        const tweetId = getTweetIdFromElement(videoElement);
        if (tweetId && capturedVideos.has(tweetId)) {
            return capturedVideos.get(tweetId);
        }

        // 2. Try to find mp4 URL from poster image (shares same path prefix)
        const poster = videoElement.getAttribute('poster') || '';
        const posterMatch = poster.match(/amplify_video_thumb\/(\d+)\//);
        if (posterMatch) {
            const videoId = posterMatch[1];
            const matching = allMp4Urls.find(u => u.includes(videoId));
            if (matching) {
                return { url: matching, allVariants: [] };
            }
        }
        const extMatch = poster.match(/ext_tw_video_thumb\/(\d+)\//);
        if (extMatch) {
            const videoId = extMatch[1];
            const matching = allMp4Urls.find(u => u.includes(videoId));
            if (matching) {
                return { url: matching, allVariants: [] };
            }
        }

        // 3. Return most recent captured video as last resort
        if (allMp4Urls.length > 0) {
            return { url: allMp4Urls[allMp4Urls.length - 1], allVariants: [] };
        }

        return null;
    }

    // --- Download function ---
    function downloadVideo(url, filename) {
        // Try GM_download first (handles CORS)
        if (typeof GM_download === 'function') {
            GM_download({
                url: url,
                name: filename,
                onerror: (err) => {
                    console.warn('GM_download failed, trying fallback:', err);
                    fallbackDownload(url, filename);
                }
            });
        } else {
            fallbackDownload(url, filename);
        }
    }

    function fallbackDownload(url, filename) {
        // Use GM_xmlhttpRequest to bypass CORS
        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: function (response) {
                    const blob = response.response;
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(blobUrl);
                },
                onerror: function () {
                    // Last resort: open in new tab
                    window.open(url, '_blank');
                }
            });
        } else {
            window.open(url, '_blank');
        }
    }

    // --- UI: Add download buttons ---
    const BUTTON_ATTR = 'data-vid-dl-added';

    function addDownloadButtons() {
        // Find all video players
        const videoPlayers = document.querySelectorAll('[data-testid="videoPlayer"]');

        videoPlayers.forEach(player => {
            if (player.getAttribute(BUTTON_ATTR)) return;
            player.setAttribute(BUTTON_ATTR, 'true');

            const btn = document.createElement('button');
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" width="18" height="18" fill="white" style="vertical-align:middle">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-5H7l5-7 5 7h-4v5h-2z" transform="rotate(180 12 12)"/>
                </svg>
                <span style="margin-left:4px;vertical-align:middle">Download</span>
            `;
            Object.assign(btn.style, {
                position: 'absolute',
                top: '8px',
                right: '8px',
                zIndex: '9999',
                background: 'rgba(0,0,0,0.75)',
                color: 'white',
                border: '2px solid rgba(255,255,255,0.3)',
                borderRadius: '20px',
                padding: '6px 14px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '700',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                display: 'flex',
                alignItems: 'center',
                backdropFilter: 'blur(4px)',
                transition: 'all 0.2s ease',
                opacity: '0',
                pointerEvents: 'auto',
            });

            // Show on hover over the player area
            player.style.position = 'relative';

            const showBtn = () => { btn.style.opacity = '1'; };
            const hideBtn = () => { btn.style.opacity = '0'; };

            player.addEventListener('mouseenter', showBtn);
            player.addEventListener('mouseleave', hideBtn);
            btn.addEventListener('mouseenter', showBtn);

            btn.addEventListener('mouseover', () => {
                btn.style.background = 'rgba(29,155,240,0.9)';
                btn.style.borderColor = 'rgba(29,155,240,1)';
            });
            btn.addEventListener('mouseout', () => {
                btn.style.background = 'rgba(0,0,0,0.75)';
                btn.style.borderColor = 'rgba(255,255,255,0.3)';
            });

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                const video = player.querySelector('video');
                if (!video) {
                    showToast('No video element found');
                    return;
                }

                const info = findVideoUrl(video);
                if (!info || !info.url) {
                    // Try fetching via API as fallback
                    const tweetId = getTweetIdFromElement(player) || getTweetIdFromUrl(window.location.href);
                    if (tweetId) {
                        fetchVideoFromApi(tweetId, btn);
                    } else {
                        showToast('Could not find video URL. Try playing the video first, then click download.');
                    }
                    return;
                }

                // Show quality picker if multiple variants
                if (info.allVariants && info.allVariants.length > 1) {
                    showQualityPicker(info.allVariants, btn, player);
                } else {
                    const tweetId = getTweetIdFromElement(player) || 'video';
                    const filename = `twitter_${tweetId}_${Date.now()}.mp4`;
                    downloadVideo(info.url, filename);
                    showToast('Downloading video...');
                }
            }, true);

            player.appendChild(btn);
        });
    }

    // --- Quality picker popup ---
    function showQualityPicker(variants, anchorBtn, player) {
        // Remove existing picker
        document.querySelectorAll('.vid-dl-picker').forEach(el => el.remove());

        const picker = document.createElement('div');
        picker.className = 'vid-dl-picker';
        Object.assign(picker.style, {
            position: 'absolute',
            top: '44px',
            right: '8px',
            zIndex: '10000',
            background: 'rgba(0,0,0,0.9)',
            borderRadius: '12px',
            padding: '8px 0',
            minWidth: '160px',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.2)',
        });

        const tweetId = getTweetIdFromElement(player) || 'video';

        variants.forEach(v => {
            const item = document.createElement('button');
            const height = v.bitrate ? Math.round(v.bitrate / 1000) + 'kbps' : 'Unknown';
            // Try to extract resolution from URL
            const resMatch = v.url.match(/\/(\d+)x(\d+)\//);
            const resolution = resMatch ? `${resMatch[1]}x${resMatch[2]}` : '';
            item.textContent = `${resolution || height}${resolution ? ` (${height})` : ''}`;
            Object.assign(item.style, {
                display: 'block',
                width: '100%',
                padding: '8px 16px',
                background: 'none',
                border: 'none',
                color: 'white',
                cursor: 'pointer',
                fontSize: '13px',
                textAlign: 'left',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            });
            item.addEventListener('mouseover', () => { item.style.background = 'rgba(255,255,255,0.1)'; });
            item.addEventListener('mouseout', () => { item.style.background = 'none'; });
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const filename = `twitter_${tweetId}_${resolution || 'video'}_${Date.now()}.mp4`;
                downloadVideo(v.url, filename);
                picker.remove();
                showToast('Downloading video...');
            }, true);
            picker.appendChild(item);
        });

        // Close on click outside
        setTimeout(() => {
            document.addEventListener('click', function handler(e) {
                if (!picker.contains(e.target)) {
                    picker.remove();
                    document.removeEventListener('click', handler);
                }
            });
        }, 100);

        player.appendChild(picker);
    }

    // --- Fetch video URL via Twitter's guest/syndication API ---
    function fetchVideoFromApi(tweetId, btn) {
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span style="vertical-align:middle">Loading...</span>';

        // Use the syndication API (no auth needed)
        const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`;

        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                responseType: 'json',
                onload: function (response) {
                    btn.innerHTML = originalText;
                    try {
                        const data = typeof response.response === 'string'
                            ? JSON.parse(response.response) : response.response;
                        extractVideoUrls(data, tweetId);
                        const info = capturedVideos.get(tweetId);
                        if (info) {
                            if (info.allVariants && info.allVariants.length > 1) {
                                showQualityPicker(info.allVariants, btn, btn.closest('[data-testid="videoPlayer"]'));
                            } else {
                                const filename = `twitter_${tweetId}_${Date.now()}.mp4`;
                                downloadVideo(info.url, filename);
                                showToast('Downloading video...');
                            }
                        } else {
                            showToast('Could not extract video URL from API');
                        }
                    } catch (e) {
                        showToast('Failed to parse API response');
                    }
                },
                onerror: function () {
                    btn.innerHTML = originalText;
                    showToast('API request failed');
                }
            });
        } else {
            btn.innerHTML = originalText;
            fetch(apiUrl)
                .then(r => r.json())
                .then(data => {
                    extractVideoUrls(data, tweetId);
                    const info = capturedVideos.get(tweetId);
                    if (info) {
                        const filename = `twitter_${tweetId}_${Date.now()}.mp4`;
                        downloadVideo(info.url, filename);
                        showToast('Downloading video...');
                    }
                })
                .catch(() => showToast('Could not fetch video URL'));
        }
    }

    // --- Toast notification ---
    function showToast(message) {
        const existing = document.getElementById('vid-dl-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'vid-dl-toast';
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed',
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(29,155,240,0.95)',
            color: 'white',
            padding: '12px 24px',
            borderRadius: '24px',
            fontSize: '14px',
            fontWeight: '600',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            zIndex: '99999',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            transition: 'opacity 0.3s ease',
        });
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // --- Keyboard shortcut: Ctrl+Shift+D to download visible video ---
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            e.preventDefault();
            // Find the most prominent video on screen
            const videos = document.querySelectorAll('[data-testid="videoPlayer"] video');
            if (videos.length === 0) {
                showToast('No video found on page');
                return;
            }
            // Pick the one most visible in viewport
            let bestVideo = null;
            let bestScore = -1;
            videos.forEach(v => {
                const rect = v.getBoundingClientRect();
                const visible = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
                if (visible > bestScore) {
                    bestScore = visible;
                    bestVideo = v;
                }
            });
            if (bestVideo) {
                const info = findVideoUrl(bestVideo);
                if (info?.url) {
                    const tweetId = getTweetIdFromElement(bestVideo) || 'video';
                    downloadVideo(info.url, `twitter_${tweetId}_${Date.now()}.mp4`);
                    showToast('Downloading video...');
                } else {
                    showToast('Video URL not captured yet. Try playing it first.');
                }
            }
        }
    });

    // --- Observer to add buttons as new videos appear ---
    function init() {
        // Initial scan
        addDownloadButtons();

        // Watch for DOM changes (infinite scroll, navigation)
        const observer = new MutationObserver(() => {
            addDownloadButtons();
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
