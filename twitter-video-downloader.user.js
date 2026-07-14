// ==UserScript==
// @name         X/Twitter Video Downloader
// @namespace    http://tampermonkey.net/
// @version      5.2.0
// @description  One-click best-quality video and audio downloads from X/Twitter
// @author       saintordevil
// @license      MIT
// @homepageURL  https://github.com/saintordevil/twitter-video-downloader
// @supportURL   https://github.com/saintordevil/twitter-video-downloader/issues
// @updateURL    https://raw.githubusercontent.com/saintordevil/twitter-video-downloader/master/twitter-video-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/saintordevil/twitter-video-downloader/master/twitter-video-downloader.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      video.twimg.com
// @connect      cdn.syndication.twimg.com
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '5.2.0';
    const LOG_PREFIX = '[TwitterVideoDownloader]';
    const INSTANCE_KEY = '__saintordevilTwitterVideoDownloader';
    const MAX_CAPTURED_VIDEOS = 500;
    const MAX_PLAYLIST_SEGMENTS = 5000;
    const MAX_ASSEMBLY_BYTES = 1024 * 1024 * 1024;

    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);
    const reportError = (...args) => console.error(LOG_PREFIX, ...args);
    const safeErrorMessage = error => {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || 'Unknown error');
        return message.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 240);
    };

    // The declared unsafeWindow grant is required so page fetch/XHR traffic can be observed.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const previousInstance = pageWindow[INSTANCE_KEY];
    if (previousInstance?.version === SCRIPT_VERSION) {
        log(`v${SCRIPT_VERSION} is already active; duplicate injection skipped.`);
        return;
    }
    if (typeof previousInstance?.destroy === 'function') {
        try {
            previousInstance.destroy('version-replaced');
        } catch (error) {
            warn('Previous instance cleanup failed:', safeErrorMessage(error));
        }
    }

    // ==================== OWNED STATE ====================

    const capturedVideos = new Map();
    const activeDownloads = new Map();
    const activeRequestHandles = new Set();
    const xhrMetadata = new WeakMap();
    const playerMediaBindings = new WeakMap();
    const modifiedPlayers = new Map();
    const pendingScanRoots = new Set();
    const uiEvents = new AbortController();
    let capturedAuth = null;
    let capturedTweetEndpoint = null;
    let fetchInterceptCount = 0;
    let mutationObserver = null;
    let scanFrame = null;
    let toastTimer = null;
    let toastRemovalTimer = null;
    let destroyed = false;
    let anonymousDownloadId = 0;

    // Public web-client bearer used by X itself. User session material is never logged or persisted.
    const WEB_CLIENT_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    const instance = { version: SCRIPT_VERSION, destroy };
    pageWindow[INSTANCE_KEY] = instance;

    // ==================== NETWORK INTERCEPTORS ====================

    const originalFetch = pageWindow.fetch;
    async function fetchWrapper(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        try {
            const init = args[1] || {};
            if (isTwitterApiUrl(url)) {
                captureAuthHeaders(extractHeadersObj(init.headers || args[0]?.headers), url);
                captureTweetEndpoint(url);
            }
        } catch (error) {
            warn('Fetch request inspection failed:', safeErrorMessage(error));
        }

        const response = await Reflect.apply(originalFetch, this, args);
        try {
            if (response.ok && isTwitterApiUrl(url) && isVideoPayloadUrl(url)) {
                fetchInterceptCount++;
                const clone = response.clone();
                clone.json().then(json => {
                    if (destroyed) return;
                    const before = capturedVideos.size;
                    extractVideoUrls(json);
                    if (capturedVideos.size > before) {
                        log('Captured video metadata.', { cached: capturedVideos.size, interceptedResponses: fetchInterceptCount });
                    }
                }).catch(error => warn('Skipped a non-JSON API response:', safeErrorMessage(error)));
            }
        } catch (error) {
            warn('Fetch response inspection failed:', safeErrorMessage(error));
        }
        return response;
    }
    pageWindow.fetch = fetchWrapper;

    const XHR = pageWindow.XMLHttpRequest.prototype;
    const originalXhrOpen = XHR.open;
    const originalXhrSend = XHR.send;
    const originalXhrSetHeader = XHR.setRequestHeader;
    function xhrOpenWrapper(method, url, ...rest) {
        xhrMetadata.set(this, { url: String(url), headers: {} });
        return originalXhrOpen.call(this, method, url, ...rest);
    }
    function xhrSetHeaderWrapper(name, value) {
        const metadata = xhrMetadata.get(this);
        if (metadata) metadata.headers[String(name).toLowerCase()] = String(value);
        return originalXhrSetHeader.call(this, name, value);
    }
    function xhrSendWrapper(...args) {
        this.addEventListener('load', function () {
            try {
                if (destroyed) return;
                const metadata = xhrMetadata.get(this);
                const url = metadata?.url || '';
                if (isTwitterApiUrl(url)) {
                    captureAuthHeaders(metadata?.headers || {}, url);
                    captureTweetEndpoint(url);
                }
                if (this.status >= 200 && this.status < 300 && isTwitterApiUrl(url) && isVideoPayloadUrl(url)) {
                    const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                    extractVideoUrls(payload);
                }
            } catch (error) {
                warn('XHR response inspection failed:', safeErrorMessage(error));
            }
        }, { once: true });
        return originalXhrSend.apply(this, args);
    }
    XHR.open = xhrOpenWrapper;
    XHR.setRequestHeader = xhrSetHeaderWrapper;
    XHR.send = xhrSendWrapper;

    function getApprovedTwitterOrigin(url) {
        if (typeof url !== 'string') return null;
        try {
            const parsed = new URL(url, location.origin);
            return parsed.origin === 'https://x.com' || parsed.origin === 'https://twitter.com' ? parsed.origin : null;
        } catch {
            return null;
        }
    }

    function isTwitterApiUrl(url) {
        if (!getApprovedTwitterOrigin(url)) return false;
        const parsed = new URL(url, location.origin);
        return parsed.pathname.startsWith('/i/api/graphql/') || parsed.pathname.startsWith('/i/api/1.1/');
    }

    function isVideoPayloadUrl(url) {
        return typeof url === 'string' && (
            url.includes('/graphql/') || url.includes('TweetDetail') || url.includes('Timeline') ||
            url.includes('TweetResultByRestId') || url.includes('Likes') || url.includes('Bookmark')
        );
    }

    function extractHeadersObj(headers) {
        const result = {};
        if (!headers) return result;
        if (typeof headers.forEach === 'function') { headers.forEach((v, k) => { result[String(k).toLowerCase()] = String(v); }); }
        else if (Array.isArray(headers)) { headers.forEach(([k, v]) => { result[k.toLowerCase()] = v; }); }
        else { Object.entries(headers).forEach(([k, v]) => { result[k.toLowerCase()] = String(v); }); }
        return result;
    }

    function captureAuthHeaders(headers, requestUrl) {
        const origin = getApprovedTwitterOrigin(requestUrl);
        if (!origin) return;
        const authorization = headers.authorization;
        const csrfToken = headers['x-csrf-token'];
        if (!authorization && !csrfToken) return;
        const existing = capturedAuth?.origin === origin ? capturedAuth : null;
        const firstCapture = existing === null;
        capturedAuth = {
            origin,
            authorization: typeof authorization === 'string' && authorization ? authorization : existing?.authorization || null,
            csrfToken: typeof csrfToken === 'string' && csrfToken ? csrfToken : existing?.csrfToken || null,
        };
        if (firstCapture) log('Captured the minimum session headers needed for an on-page video lookup.');
    }

    function captureTweetEndpoint(url) {
        if (typeof url !== 'string' || !url.includes('TweetResultByRestId')) return;
        try {
            const parsed = new URL(url, location.origin);
            if (!getApprovedTwitterOrigin(parsed.href)) return;
            if (!/^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/TweetResultByRestId$/.test(parsed.pathname)) return;
            if (capturedAuth && capturedAuth.origin !== parsed.origin) return;
            const endpoint = `${parsed.origin}${parsed.pathname}`;
            if (endpoint !== capturedTweetEndpoint) {
                capturedTweetEndpoint = endpoint;
                log('Captured the current TweetResultByRestId endpoint.');
            }
        } catch (error) {
            warn('Ignored an invalid API endpoint:', safeErrorMessage(error));
        }
    }

    // ==================== DATA EXTRACTION ====================

    function isValidTweetId(value) {
        return typeof value === 'string' && /^\d{5,25}$/.test(value);
    }

    function readVideoInfo(value) {
        const variants = value?.video_info?.variants;
        if (!Array.isArray(variants)) return null;
        const m3u8 = variants.find(variant => variant?.content_type === 'application/x-mpegURL' && isAllowedMediaUrl(variant.url));
        const mp4Variants = variants
            .filter(variant => variant?.content_type === 'video/mp4' && isAllowedMediaUrl(variant.url))
            .map(variant => ({ url: variant.url, bitrate: Number(variant.bitrate) || 0 }))
            .sort((a, b) => b.bitrate - a.bitrate);
        if (!m3u8 && mp4Variants.length === 0) return null;
        return { mediaKey: typeof value.media_key === 'string' ? value.media_key : null, mp4Variants, m3u8Url: m3u8?.url || null };
    }

    function isAllowedMediaUrl(url) {
        if (typeof url !== 'string') return false;
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'video.twimg.com';
        } catch {
            return false;
        }
    }

    function resolveMediaUrl(relativeUrl, baseUrl) {
        const resolved = new URL(relativeUrl, baseUrl).href;
        if (!isAllowedMediaUrl(resolved)) throw new Error('Playlist referenced an unapproved media host');
        return resolved;
    }

    function looksLikeTweetObject(value) {
        return value && typeof value === 'object' && isValidTweetId(value.rest_id) && (
            value.__typename === 'Tweet' || value.__typename === 'TweetWithVisibilityResults' ||
            Array.isArray(value.legacy?.extended_entities?.media) || Array.isArray(value.legacy?.entities?.media)
        );
    }

    function storeVideoInfo(tweetId, info) {
        if (!isValidTweetId(tweetId) || !info) return;
        const existingRecord = capturedVideos.get(tweetId);
        const videos = existingRecord?.videos ? [...existingRecord.videos] : [];
        const signature = info.mediaKey || info.m3u8Url || info.mp4Variants?.[0]?.url;
        const existingIndex = videos.findIndex(video => (video.mediaKey || video.m3u8Url || video.mp4Variants?.[0]?.url) === signature);
        if (existingIndex >= 0) {
            const existing = videos[existingIndex];
            videos[existingIndex] = {
                mediaKey: info.mediaKey || existing.mediaKey || null,
                mp4Variants: info.mp4Variants?.length ? info.mp4Variants : existing.mp4Variants,
                m3u8Url: info.m3u8Url || existing.m3u8Url,
                capturedAt: Date.now(),
            };
        } else {
            videos.push({
                mediaKey: info.mediaKey || null,
                mp4Variants: info.mp4Variants || [],
                m3u8Url: info.m3u8Url || null,
                capturedAt: Date.now(),
            });
        }
        const primary = videos[0] || { mp4Variants: [], m3u8Url: null };
        const merged = { videos, ...primary };
        capturedVideos.delete(tweetId);
        capturedVideos.set(tweetId, merged);
        while (capturedVideos.size > MAX_CAPTURED_VIDEOS) {
            capturedVideos.delete(capturedVideos.keys().next().value);
        }
    }

    function extractVideoUrls(root, fallbackTweetId = null) {
        if (!root || typeof root !== 'object') return;
        const stack = [{ value: root, tweetId: isValidTweetId(fallbackTweetId) ? fallbackTweetId : null }];
        const seen = new WeakSet();
        while (stack.length > 0) {
            const { value, tweetId } = stack.pop();
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            const currentTweetId = looksLikeTweetObject(value) ? value.rest_id : tweetId;
            const info = readVideoInfo(value);
            if (currentTweetId && info) storeVideoInfo(currentTweetId, info);
            const children = Array.isArray(value) ? value : Object.values(value);
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push({ value: children[i], tweetId: currentTweetId });
            }
        }
    }

    function findUniqueVideoInfoInJson(root) {
        if (!root || typeof root !== 'object') return null;
        const stack = [root];
        const seen = new WeakSet();
        const matches = new Map();
        while (stack.length > 0) {
            const value = stack.pop();
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            const info = readVideoInfo(value);
            if (info) {
                const signature = info.m3u8Url || info.mp4Variants[0]?.url;
                if (signature) matches.set(signature, info);
            }
            const children = Array.isArray(value) ? value : Object.values(value);
            children.forEach(child => stack.push(child));
        }
        return matches.size === 1 ? matches.values().next().value : null;
    }

    // ==================== ACTIVE API FETCH ====================

    function getCsrfToken() {
        const m = document.cookie.match(/ct0=([^;]+)/);
        return m ? m[1] : '';
    }

    function getAuthHeaders(origin) {
        if (capturedAuth?.origin === origin && (capturedAuth.authorization || capturedAuth.csrfToken)) {
            return {
                'authorization': capturedAuth.authorization || `Bearer ${WEB_CLIENT_BEARER}`,
                'x-csrf-token': capturedAuth.csrfToken || getCsrfToken(),
                'x-twitter-active-user': 'yes',
                'x-twitter-auth-type': 'OAuth2Session',
            };
        }
        if (getApprovedTwitterOrigin(location.href) !== origin) return null;
        const csrf = getCsrfToken();
        if (!csrf) return null;
        return { 'authorization': `Bearer ${WEB_CLIENT_BEARER}`, 'x-csrf-token': csrf, 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session' };
    }

    async function fetchTweetVideoData(tweetId) {
        const pageOrigin = getApprovedTwitterOrigin(location.href) || 'https://x.com';
        const base = capturedTweetEndpoint || `${pageOrigin}/i/api/graphql/xOhkmRac04YFZmOzU9PJHg/TweetResultByRestId`;
        const authHeaders = getAuthHeaders(new URL(base).origin);
        log('Starting an on-page video metadata lookup.', { authenticated: !!authHeaders, endpointCaptured: !!capturedTweetEndpoint });
        if (authHeaders) {
            try {
                const variables = JSON.stringify({ tweetId, withCommunity: false, includePromotedContent: false, withVoice: false });
                const features = JSON.stringify({
                    creator_subscriptions_tweet_preview_api_enabled: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
                    tweetypie_unmention_optimization_enabled: true, responsive_web_edit_tweet_api_enabled: true,
                    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true,
                    longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
                    tweet_awards_web_tipping_enabled: false, responsive_web_home_pinned_timelines_enabled: true,
                    freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true,
                    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, rweb_video_timestamps_enabled: true,
                    longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true,
                    responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false,
                    responsive_web_media_download_video_enabled: false, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
                    responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_enhance_cards_enabled: false,
                });
                const fieldToggles = JSON.stringify({ withArticleRichContentState: true, withArticlePlainText: false, withGrokAnalyze: false, withDisallowedReplyControls: false });
                const apiUrl = `${base}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}&fieldToggles=${encodeURIComponent(fieldToggles)}`;
                const lookupController = new AbortController();
                const lookupTimeout = setTimeout(() => lookupController.abort(), 15000);
                let response;
                try {
                    response = await originalFetch.call(pageWindow, apiUrl, {
                        method: 'GET', headers: authHeaders, credentials: 'include', signal: lookupController.signal,
                    });
                } finally {
                    clearTimeout(lookupTimeout);
                }
                log('On-page API lookup completed.', { status: response.status });
                if (response.ok) {
                    const data = await response.json();
                    extractVideoUrls(data, tweetId);
                    let result = capturedVideos.get(tweetId) || null;
                    if (!result) {
                        // Only use an unattributed fallback when the payload contains exactly one video.
                        result = findUniqueVideoInfoInJson(data);
                        if (result) storeVideoInfo(tweetId, result);
                    }
                    log('On-page metadata lookup result.', { found: !!result, hasHls: !!result?.m3u8Url, directVariants: result?.mp4Variants?.length || 0 });
                    return result;
                }
                warn('On-page metadata lookup was rejected.', { status: response.status });
            } catch (error) {
                reportError('On-page metadata lookup failed:', safeErrorMessage(error));
            }
        } else {
            warn('No current X/Twitter session headers are available; skipping the authenticated lookup.');
        }
        log('Trying the syndication metadata fallback.');
        try {
            const text = await gmFetchText(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`, null, 3);
            extractVideoUrls(JSON.parse(text), tweetId);
            const result = capturedVideos.get(tweetId) || null;
            log('Syndication metadata lookup result.', { found: !!result, hasHls: !!result?.m3u8Url, directVariants: result?.mp4Variants?.length || 0 });
            return result;
        } catch (error) {
            reportError('Syndication metadata lookup failed:', safeErrorMessage(error));
        }
        return null;
    }

    // ==================== TWEET ID HELPERS ====================

    function getTweetIdFromUrl(url) { const m = url.match(/\/status\/(\d+)/); return m ? m[1] : null; }

    function getTweetIdFromElement(el) {
        let cur = el;
        while (cur && cur !== document.body) {
            if (cur.tagName === 'ARTICLE') {
                const t = cur.querySelector('a[href*="/status/"] time');
                if (t) return getTweetIdFromUrl(t.closest('a').href);
            }
            const links = cur.querySelectorAll?.('a[href*="/status/"]');
            if (links?.length) { for (const l of links) { const id = getTweetIdFromUrl(l.href); if (id) return id; } }
            cur = cur.parentElement;
        }
        return getTweetIdFromUrl(window.location.href);
    }

    function getMediaSignature(video) {
        return video?.mediaKey || video?.m3u8Url || video?.mp4Variants?.[0]?.url || null;
    }

    function getPlayerMediaHints(player) {
        const hints = new Set();
        const add = value => {
            if (typeof value === 'string' && value && value.length <= 4096) hints.add(value);
        };
        for (const node of [player, ...(player.querySelectorAll?.('video, source, img') || [])]) {
            add(node.currentSrc);
            add(node.src);
            add(node.poster);
            add(node.getAttribute?.('src'));
            add(node.getAttribute?.('poster'));
        }
        return [...hints];
    }

    function findVideoByHints(videos, hints) {
        if (!hints.length) return null;
        return videos.find(video => {
            const token = typeof video.mediaKey === 'string' ? video.mediaKey.split('_').pop() : null;
            return token && token.length >= 5 && hints.some(value => value.includes(token));
        }) || null;
    }

    function getVideoInfoForElement(element) {
        const hintedTweetId = getTweetIdFromElement(element);
        const player = element.closest?.('[data-testid="videoPlayer"]') || element;
        const binding = playerMediaBindings.get(player);
        if (binding) {
            const boundRecord = capturedVideos.get(binding.tweetId);
            const boundVideo = boundRecord?.videos?.find(video => getMediaSignature(video) === binding.signature);
            if (boundVideo) return { tweetId: binding.tweetId, ...boundVideo };
        }

        const hints = getPlayerMediaHints(player);
        const hintedRecord = hintedTweetId ? capturedVideos.get(hintedTweetId) : null;
        let selectedTweetId = hintedTweetId;
        let selected = findVideoByHints(hintedRecord?.videos || [], hints);
        if (!selected && hints.length) {
            for (const [candidateTweetId, record] of capturedVideos) {
                selected = findVideoByHints(record.videos || [], hints);
                if (selected) {
                    selectedTweetId = candidateTweetId;
                    break;
                }
            }
        }
        if (!selected && hintedRecord) {
            const article = player.closest?.('article');
            const players = article ? [...article.querySelectorAll('[data-testid="videoPlayer"]')] : [];
            const playerIndex = Math.max(0, players.indexOf(player));
            selected = hintedRecord.videos?.[playerIndex] || hintedRecord.videos?.[0] || hintedRecord;
        }
        if (selected && selectedTweetId) {
            const signature = getMediaSignature(selected);
            if (signature) playerMediaBindings.set(player, { tweetId: selectedTweetId, signature });
            return { tweetId: selectedTweetId, ...selected };
        }
        return { tweetId: hintedTweetId || null, mp4Variants: [], m3u8Url: null };
    }

    // ==================== M3U8 PARSING ====================

    function parseHlsAttributes(line) {
        const attributes = {};
        const body = line.slice(line.indexOf(':') + 1);
        const pattern = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
        let match;
        while ((match = pattern.exec(body))) {
            const raw = match[2].trim();
            attributes[match[1]] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
        }
        return attributes;
    }

    function parseM3U8Master(content, baseUrl) {
        const lines = content.split('\n');
        const variants = [];
        const audioGroups = new Map();

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.startsWith('#EXT-X-MEDIA:')) {
                const attributes = parseHlsAttributes(line);
                if (attributes.TYPE === 'AUDIO' && attributes.URI && attributes['GROUP-ID']) {
                    const candidates = audioGroups.get(attributes['GROUP-ID']) || [];
                    candidates.push({
                        url: resolveMediaUrl(attributes.URI, baseUrl),
                        preference: attributes.DEFAULT === 'YES' ? 2 : attributes.AUTOSELECT === 'YES' ? 1 : 0,
                    });
                    audioGroups.set(attributes['GROUP-ID'], candidates);
                }
            }
        }
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const attributes = parseHlsAttributes(line);
                const bandwidth = Number.parseInt(attributes['AVERAGE-BANDWIDTH'] || attributes.BANDWIDTH || '0', 10) || 0;
                const resolution = /^\d+x\d+$/.test(attributes.RESOLUTION || '') ? attributes.RESOLUTION : '';
                for (let j = i + 1; j < lines.length; j++) {
                    const next = lines[j].trim();
                    if (next && !next.startsWith('#')) {
                        const group = audioGroups.get(attributes.AUDIO) || [];
                        const audio = [...group].sort((a, b) => b.preference - a.preference)[0] || null;
                        variants.push({ bandwidth, resolution, url: resolveMediaUrl(next, baseUrl), audioPlaylistUrl: audio?.url || null });
                        break;
                    }
                }
            }
        }
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        return { variants, audioPlaylistUrl: variants[0]?.audioPlaylistUrl || null };
    }

    function parseM3U8Variant(content, baseUrl) {
        const lines = content.split('\n');
        const segments = [];
        let initSegmentUrl = null;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#EXT-X-KEY:')) {
                const method = parseHlsAttributes(trimmed).METHOD;
                if (method && method !== 'NONE') throw new Error(`Encrypted HLS (${method}) is not supported`);
            }
            if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
                throw new Error('Byte-range HLS playlists are not supported');
            }
            if (trimmed === '#EXT-X-DISCONTINUITY') {
                throw new Error('Discontinuous HLS playlists are not supported');
            }
            if (trimmed.startsWith('#EXT-X-MAP:')) {
                const mapAttributes = parseHlsAttributes(trimmed);
                if (mapAttributes.BYTERANGE) throw new Error('Byte-range HLS init segments are not supported');
                const uri = mapAttributes.URI;
                if (uri) {
                    const nextInitSegmentUrl = resolveMediaUrl(uri, baseUrl);
                    if (initSegmentUrl && initSegmentUrl !== nextInitSegmentUrl) {
                        throw new Error('Multiple HLS init segments are not supported');
                    }
                    initSegmentUrl = nextInitSegmentUrl;
                }
            } else if (trimmed && !trimmed.startsWith('#')) {
                segments.push(resolveMediaUrl(trimmed, baseUrl));
                if (segments.length > MAX_PLAYLIST_SEGMENTS) throw new Error('Playlist exceeds the safe segment limit');
            }
        }
        return { segments, initSegmentUrl };
    }

    // ==================== FETCH HELPERS ====================

    class RequestFailure extends Error {
        constructor(message, { status = 0, retryAfterMs = 0, retryable = false } = {}) {
            super(message);
            this.name = 'RequestFailure';
            this.status = status;
            this.retryAfterMs = retryAfterMs;
            this.retryable = retryable;
        }
    }

    function makeAbortError() {
        const error = new Error('Cancelled');
        error.name = 'AbortError';
        return error;
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) throw makeAbortError();
    }

    function parseResponseHeaders(rawHeaders) {
        const headers = {};
        String(rawHeaders || '').split(/\r?\n/).forEach(line => {
            const separator = line.indexOf(':');
            if (separator <= 0) return;
            headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        });
        return headers;
    }

    function retryAfterMs(rawHeaders) {
        const value = parseResponseHeaders(rawHeaders)['retry-after'];
        if (!value) return 0;
        if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.ceil(Number(value) * 1000));
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
    }

    function cancellableSleep(ms, signal) {
        return new Promise((resolve, reject) => {
            throwIfAborted(signal);
            const onAbort = () => {
                clearTimeout(timer);
                reject(makeAbortError());
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    function gmRequest(url, { responseType = 'text', timeout = 30000, signal = null } = {}) {
        return new Promise((resolve, reject) => {
            throwIfAborted(signal);
            let handle = null;
            let settled = false;

            const cleanup = () => {
                if (handle) activeRequestHandles.delete(handle);
                signal?.removeEventListener('abort', onAbort);
            };
            const settle = (callback, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback(value);
            };
            const onAbort = () => {
                try { handle?.abort?.(); } catch {}
                settle(reject, makeAbortError());
            };

            try {
                handle = GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType,
                    timeout,
                    onload: response => settle(resolve, response),
                    onabort: () => settle(reject, makeAbortError()),
                    onerror: () => settle(reject, new RequestFailure('Network request failed', { retryable: true })),
                    ontimeout: () => settle(reject, new RequestFailure('Network request timed out', { retryable: true })),
                });
                if (!settled) {
                    if (handle) activeRequestHandles.add(handle);
                    if (signal?.aborted) onAbort();
                    else signal?.addEventListener('abort', onAbort, { once: true });
                }
            } catch (error) {
                settle(reject, error);
            }
        });
    }

    async function fetchWithRetry(url, { responseType = 'text', signal = null, attempts = 5, validate = null } = {}) {
        let lastError = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            throwIfAborted(signal);
            try {
                const response = await gmRequest(url, { responseType, signal });
                const status = Number(response.status) || 0;
                if (status < 200 || status >= 300) {
                    const retryable = status === 408 || status === 429 || status >= 500;
                    throw new RequestFailure(`HTTP ${status || 'error'}`, {
                        status,
                        retryAfterMs: status === 429 ? retryAfterMs(response.responseHeaders) : 0,
                        retryable,
                    });
                }
                const value = responseType === 'text' ? response.responseText : response.response;
                const hasData = responseType === 'text' ? typeof value === 'string' : value && (value.byteLength > 0 || value.size > 0);
                if (!hasData || (validate && !validate(value))) {
                    throw new RequestFailure('Response validation failed', { retryable: true });
                }
                return value;
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                lastError = error;
                if (!error?.retryable || attempt === attempts) throw error;
                const exponential = Math.min(10000, 750 * (2 ** (attempt - 1)));
                const delay = Math.max(error.retryAfterMs || 0, exponential + Math.floor(Math.random() * 250));
                warn('Transient media request failed; retry scheduled.', { attempt, attempts, status: error.status || 0, delayMs: delay });
                await cancellableSleep(delay, signal);
            }
        }
        throw lastError || new RequestFailure('Request failed');
    }

    function gmFetchText(url, signal = null, attempts = 3) {
        return fetchWithRetry(url, { responseType: 'text', signal, attempts, validate: value => value.length > 0 });
    }

    function gmFetchArrayBuffer(url, signal = null, attempts = 5) {
        return fetchWithRetry(url, { responseType: 'arraybuffer', signal, attempts, validate: validateSegment });
    }

    function gmFetchRetry(url, signal = null, attempts = 5) {
        return gmFetchArrayBuffer(url, signal, attempts);
    }

    // ==================== fMP4 BOX UTILITIES ====================

    const MP4 = {
        u32(buf, off) {
            if (!buf || off < 0 || off + 4 > buf.length) throw new Error('MP4 read exceeded buffer bounds');
            return (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
        },
        w32(buf, off, val) {
            if (!buf || off < 0 || off + 4 > buf.length) throw new Error('MP4 write exceeded buffer bounds');
            buf[off] = (val >> 24) & 0xff; buf[off + 1] = (val >> 16) & 0xff;
            buf[off + 2] = (val >> 8) & 0xff; buf[off + 3] = val & 0xff;
        },
        type(buf, off) {
            if (!buf || off < 0 || off + 8 > buf.length) throw new Error('Invalid MP4 box header');
            return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
        },
        boxSize(buf, off, end) {
            const size = MP4.u32(buf, off);
            if (size === 0) return end - off;
            if (size === 1) {
                if (off + 16 > end) throw new Error('Truncated extended MP4 box');
                const extended = MP4.u32(buf, off + 8) * 0x100000000 + MP4.u32(buf, off + 12);
                if (!Number.isSafeInteger(extended)) throw new Error('MP4 box exceeds safe integer range');
                return extended;
            }
            return size;
        },

        findBox(buf, type, start, end) {
            let pos = start;
            while (pos + 8 <= end) {
                const size = MP4.boxSize(buf, pos, end);
                if (size < 8 || pos + size > end) throw new Error('Invalid MP4 box size');
                if (MP4.type(buf, pos) === type) return { offset: pos, size };
                pos += size;
            }
            return null;
        },

        findBoxes(buf, type, start, end) {
            const boxes = [];
            let pos = start;
            while (pos + 8 <= end) {
                const size = MP4.boxSize(buf, pos, end);
                if (size < 8 || pos + size > end) throw new Error('Invalid MP4 box size');
                if (MP4.type(buf, pos) === type) boxes.push({ offset: pos, size });
                pos += size;
            }
            return boxes;
        },

        box(type, ...payloads) {
            let total = 8;
            for (const p of payloads) total += p.length;
            const r = new Uint8Array(total);
            MP4.w32(r, 0, total);
            r[4] = type.charCodeAt(0); r[5] = type.charCodeAt(1);
            r[6] = type.charCodeAt(2); r[7] = type.charCodeAt(3);
            let off = 8;
            for (const p of payloads) { r.set(p, off); off += p.length; }
            return r;
        },
    };

    // Validate an fMP4 segment has proper box structure
    function validateSegment(data) {
        try {
            if (!data || data.byteLength < 8) return false;
            const buf = new Uint8Array(data);
            const topLevelTypes = [];
            let offset = 0;
            while (offset < buf.length) {
                if (offset + 8 > buf.length) return false;
                const size = MP4.boxSize(buf, offset, buf.length);
                if (size < 8 || offset + size > buf.length) return false;
                topLevelTypes.push(MP4.type(buf, offset));
                offset += size;
            }
            if (offset !== buf.length) return false;
            const isInit = topLevelTypes.includes('moov');
            const isMedia = topLevelTypes.includes('moof') && topLevelTypes.includes('mdat');
            return isInit || isMedia;
        } catch {
            return false;
        }
    }

    // ==================== fMP4 → STANDARD MP4 TRANSMUXER ====================

    // Build a full box (with version byte + 3 flag bytes after the 8-byte header)
    function fullBox(type, ver, flags, ...payloads) {
        let total = 12;
        for (const p of payloads) total += p.length;
        const r = new Uint8Array(total);
        MP4.w32(r, 0, total);
        r[4] = type.charCodeAt(0); r[5] = type.charCodeAt(1);
        r[6] = type.charCodeAt(2); r[7] = type.charCodeAt(3);
        r[8] = ver; r[9] = (flags >> 16) & 0xff; r[10] = (flags >> 8) & 0xff; r[11] = flags & 0xff;
        let off = 12;
        for (const p of payloads) { r.set(p, off); off += p.length; }
        return r;
    }

    // Extract track info from an fMP4 init segment (moov)
    function parseTrackInfo(initData) {
        const buf = new Uint8Array(initData);
        const moov = MP4.findBox(buf, 'moov', 0, buf.length);
        if (!moov) throw new Error('No moov in init');
        const ms = moov.offset + 8, me = moov.offset + moov.size;

        const tracks = MP4.findBoxes(buf, 'trak', ms, me);
        if (tracks.length !== 1) throw new Error(`Expected one track in init, found ${tracks.length}`);
        const trak = tracks[0];
        const ts = trak.offset + 8, te = trak.offset + trak.size;

        // tkhd → dimensions
        const tkhd = MP4.findBox(buf, 'tkhd', ts, te);
        if (!tkhd || tkhd.size < 32) throw new Error('Invalid track header');
        const tkhdVersion = buf[tkhd.offset + 8];
        const trackIdOffset = tkhd.offset + (tkhdVersion === 1 ? 28 : 20);
        if (trackIdOffset + 4 > tkhd.offset + tkhd.size) throw new Error('Track ID exceeds the track header');
        const trackId = MP4.u32(buf, trackIdOffset);
        if (!trackId) throw new Error('Track ID is zero');
        const width = MP4.u32(buf, tkhd.offset + tkhd.size - 8) >>> 16;
        const height = MP4.u32(buf, tkhd.offset + tkhd.size - 4) >>> 16;

        // mdia → mdhd (timescale), hdlr (handler), stsd (codec config)
        const mdia = MP4.findBox(buf, 'mdia', ts, te);
        if (!mdia) throw new Error('No media box in track');
        const mds = mdia.offset + 8, mde = mdia.offset + mdia.size;

        const mdhd = MP4.findBox(buf, 'mdhd', mds, mde);
        if (!mdhd) throw new Error('No media header in track');
        const mdVer = buf[mdhd.offset + 8];
        const timescaleOffset = mdhd.offset + (mdVer === 1 ? 28 : 20);
        if (timescaleOffset + 4 > mdhd.offset + mdhd.size) throw new Error('Media timescale exceeds the media header');
        const timescale = MP4.u32(buf, timescaleOffset);

        const hdlr = MP4.findBox(buf, 'hdlr', mds, mde);
        if (!hdlr || hdlr.size < 20) throw new Error('Invalid media handler');
        const handler = String.fromCharCode(buf[hdlr.offset + 16], buf[hdlr.offset + 17], buf[hdlr.offset + 18], buf[hdlr.offset + 19]);

        const minf = MP4.findBox(buf, 'minf', mds, mde);
        if (!minf) throw new Error('No media information box');
        const stbl = MP4.findBox(buf, 'stbl', minf.offset + 8, minf.offset + minf.size);
        if (!stbl) throw new Error('No sample table');
        const stsd = MP4.findBox(buf, 'stsd', stbl.offset + 8, stbl.offset + stbl.size);
        if (!stsd) throw new Error('No sample description');
        const stsdBytes = buf.slice(stsd.offset, stsd.offset + stsd.size);

        // Parse trex (Track Extends) for default sample values
        const mvex = MP4.findBox(buf, 'mvex', ms, me);
        let trex = { dur: 0, size: 0, flags: 0 };
        if (mvex) {
            const trexBox = MP4.findBox(buf, 'trex', mvex.offset + 8, mvex.offset + mvex.size);
            if (trexBox) {
                if (trexBox.size < 32) throw new Error('Invalid track defaults box');
                const trexTrackId = MP4.u32(buf, trexBox.offset + 12);
                if (trexTrackId !== trackId) throw new Error('Track defaults refer to a different track');
                // trex: header(8) + ver+flags(4) + track_id(4) + desc_idx(4) + def_dur(4) + def_size(4) + def_flags(4)
                trex = {
                    dur: MP4.u32(buf, trexBox.offset + 20),
                    size: MP4.u32(buf, trexBox.offset + 24),
                    flags: MP4.u32(buf, trexBox.offset + 28),
                };
            }
        }
        if (!timescale) throw new Error('Track timescale is zero');
        log('Parsed MP4 track metadata.', { handler, timescale, width, height });

        return { trackId, timescale, handler, stsdBytes, width, height, trex };
    }

    // Parse sample metadata from one fMP4 media segment (moof+mdat)
    function parseFragmentSamples(segData, trackInfo) {
        const buf = new Uint8Array(segData);
        const moofs = MP4.findBoxes(buf, 'moof', 0, buf.length);
        const mdats = MP4.findBoxes(buf, 'mdat', 0, buf.length);
        if (moofs.length !== 1) throw new Error(`Expected one movie fragment box, found ${moofs.length}`);
        if (mdats.length !== 1) throw new Error(`Expected one media data box, found ${mdats.length}`);

        const readU32 = (offset, end, label) => {
            if (offset < 0 || offset + 4 > end) throw new Error(`${label} exceeds its MP4 box boundary`);
            return MP4.u32(buf, offset);
        };
        const readU64 = (offset, end, label) => {
            const high = readU32(offset, end, label);
            const low = readU32(offset + 4, end, label);
            const value = high * 0x100000000 + low;
            if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds the safe integer range`);
            return value;
        };

        const moof = moofs[0];
        const moofOffset = moof.offset;
        const moofEnd = moof.offset + moof.size;
        const trafs = MP4.findBoxes(buf, 'traf', moof.offset + 8, moofEnd);
        if (trafs.length !== 1) throw new Error(`Expected one fragment track, found ${trafs.length}`);
        const traf = trafs[0];
        const trafEnd = traf.offset + traf.size;

        const tfhd = MP4.findBox(buf, 'tfhd', traf.offset + 8, trafEnd);
        if (!tfhd || tfhd.size < 16) throw new Error('Invalid fragment track header');
        const tfhdEnd = tfhd.offset + tfhd.size;
        const tfhdFlags = (buf[tfhd.offset + 9] << 16) | (buf[tfhd.offset + 10] << 8) | buf[tfhd.offset + 11];
        const fragmentTrackId = readU32(tfhd.offset + 12, tfhdEnd, 'Fragment track ID');
        if (fragmentTrackId !== trackInfo.trackId) throw new Error('Fragment refers to a different track');
        let cursor = tfhd.offset + 16;
        let baseDataOffset = moofOffset;
        if (tfhdFlags & 0x000001) {
            baseDataOffset = readU64(cursor, tfhdEnd, 'Fragment base offset');
            cursor += 8;
        }
        if (tfhdFlags & 0x000002) {
            readU32(cursor, tfhdEnd, 'Sample description index');
            cursor += 4;
        }
        let defaultDuration = trackInfo.trex.dur;
        let defaultSize = trackInfo.trex.size;
        let defaultFlags = trackInfo.trex.flags;
        if (tfhdFlags & 0x000008) { defaultDuration = readU32(cursor, tfhdEnd, 'Default sample duration'); cursor += 4; }
        if (tfhdFlags & 0x000010) { defaultSize = readU32(cursor, tfhdEnd, 'Default sample size'); cursor += 4; }
        if (tfhdFlags & 0x000020) { defaultFlags = readU32(cursor, tfhdEnd, 'Default sample flags'); cursor += 4; }

        const tfdts = MP4.findBoxes(buf, 'tfdt', traf.offset + 8, trafEnd);
        if (tfdts.length !== 1) throw new Error(`Expected one decode-time box, found ${tfdts.length}`);
        const tfdt = tfdts[0];
        const tfdtEnd = tfdt.offset + tfdt.size;
        const tfdtVersion = buf[tfdt.offset + 8];
        if (tfdtVersion !== 0 && tfdtVersion !== 1) throw new Error(`Unsupported decode-time version ${tfdtVersion}`);
        const baseDecodeTime = tfdtVersion === 1
            ? readU64(tfdt.offset + 12, tfdtEnd, 'Base media decode time')
            : readU32(tfdt.offset + 12, tfdtEnd, 'Base media decode time');

        const truns = MP4.findBoxes(buf, 'trun', traf.offset + 8, trafEnd);
        if (truns.length !== 1) throw new Error(`Expected one fragment run, found ${truns.length}`);
        const trun = truns[0];
        if (trun.size < 16) throw new Error('Invalid fragment run');
        const trunEnd = trun.offset + trun.size;
        const trunVersion = buf[trun.offset + 8];
        const trunFlags = (buf[trun.offset + 9] << 16) | (buf[trun.offset + 10] << 8) | buf[trun.offset + 11];
        let trunCursor = trun.offset + 12;
        const count = readU32(trunCursor, trunEnd, 'Fragment sample count');
        trunCursor += 4;
        if (count === 0 || count > 1000000) throw new Error('Fragment sample count is invalid');
        let trunDataOffset = null;
        if (trunFlags & 0x01) {
            const rawOffset = readU32(trunCursor, trunEnd, 'Fragment data offset');
            trunCursor += 4;
            trunDataOffset = rawOffset > 0x7FFFFFFF ? rawOffset - 0x100000000 : rawOffset;
        }
        let firstFlags = -1;
        if (trunFlags & 0x04) {
            firstFlags = readU32(trunCursor, trunEnd, 'First sample flags');
            trunCursor += 4;
        }

        const hasDuration = !!(trunFlags & 0x100);
        const hasSize = !!(trunFlags & 0x200);
        const hasFlags = !!(trunFlags & 0x400);
        const hasCompositionOffset = !!(trunFlags & 0x800);
        const samples = [];
        let anyCTO = false;
        for (let index = 0; index < count; index++) {
            const duration = hasDuration ? readU32(trunCursor, trunEnd, 'Sample duration') : defaultDuration;
            if (hasDuration) trunCursor += 4;
            const size = hasSize ? readU32(trunCursor, trunEnd, 'Sample size') : defaultSize;
            if (hasSize) trunCursor += 4;
            const perSampleFlags = hasFlags ? readU32(trunCursor, trunEnd, 'Sample flags') : defaultFlags;
            if (hasFlags) trunCursor += 4;
            const flags = index === 0 && firstFlags >= 0 ? firstFlags : perSampleFlags;
            let cto = 0;
            if (hasCompositionOffset) {
                cto = readU32(trunCursor, trunEnd, 'Sample composition offset');
                trunCursor += 4;
                if (trunVersion === 1 && cto > 0x7FFFFFFF) cto -= 0x100000000;
            }
            if (!duration || !size) throw new Error('Fragment contains a zero-duration or zero-size sample');
            if (cto !== 0) anyCTO = true;
            samples.push({ dur: duration, size, flags, cto });
        }

        const mdat = mdats[0];
        const mdatHeaderSize = MP4.u32(buf, mdat.offset) === 1 ? 16 : 8;
        if (mdatHeaderSize > mdat.size) throw new Error('Invalid media data header');
        const mdatDataOff = mdat.offset + mdatHeaderSize;
        const sampleDataOff = trunDataOffset === null ? mdatDataOff : baseDataOffset + trunDataOffset;
        const sampleBytes = samples.reduce((total, sample) => total + sample.size, 0);
        if (!Number.isSafeInteger(sampleBytes)) throw new Error('Fragment sample byte count exceeds the safe integer range');
        if (sampleDataOff < mdatDataOff || sampleDataOff + sampleBytes > mdat.offset + mdat.size || sampleDataOff + sampleBytes > buf.length) {
            throw new Error('Fragment sample data exceeds media box bounds');
        }

        return { samples, mdatDataOff: sampleDataOff, anyCTO, baseDecodeTime, trackId: fragmentTrackId };
    }

    // Build a standard (non-fragmented) MP4 from fMP4 init + segments
    function transmuxToMP4(vInitData, aInitData, vSegs, aSegs, progressCb) {
        progressCb('Building standard MP4...', 100);

        const vInfo = parseTrackInfo(vInitData);
        const aInfo = aInitData ? parseTrackInfo(aInitData) : null;
        if (vInfo.handler !== 'vide') throw new Error(`Expected a video track, found ${vInfo.handler || 'unknown'}`);
        if (aInfo && aInfo.handler !== 'soun') throw new Error(`Expected an audio track, found ${aInfo.handler || 'unknown'}`);
        log('Starting MP4 transmux.', { resolution: `${vInfo.width}x${vInfo.height}`, hasAudioInit: !!aInfo });

        // Parse all segments to extract sample metadata and mdat references
        function parseTracks(segs, info) {
            const chunks = []; // { sampleMeta[], segIndex, mdatDataOff }
            let totalDur = 0, anyCTO = false, expectedDecodeTime = null, firstDecodeTime = null;
            for (let i = 0; i < segs.length; i++) {
                if (!segs[i]) throw new Error(`Missing media segment ${i + 1} of ${segs.length}`);
                const f = parseFragmentSamples(segs[i], info);
                if (!f.samples.length) throw new Error(`Media segment ${i + 1} has no samples`);
                if (expectedDecodeTime !== null && f.baseDecodeTime !== expectedDecodeTime) {
                    throw new Error(`Media segment ${i + 1} has a discontinuous decode timeline`);
                }
                if (firstDecodeTime === null) firstDecodeTime = f.baseDecodeTime;
                chunks.push({ samples: f.samples, segIdx: i, mdatDataOff: f.mdatDataOff });
                let fragmentDuration = 0;
                for (const s of f.samples) {
                    fragmentDuration += s.dur;
                    totalDur += s.dur;
                    if (!Number.isSafeInteger(fragmentDuration) || !Number.isSafeInteger(totalDur)) {
                        throw new Error('Track duration exceeds the safe integer range');
                    }
                }
                expectedDecodeTime = f.baseDecodeTime + fragmentDuration;
                if (!Number.isSafeInteger(expectedDecodeTime)) throw new Error('Track decode time exceeds the safe integer range');
                if (f.anyCTO) anyCTO = true;
            }
            return { chunks, totalDur, anyCTO, firstDecodeTime, info };
        }

        const vTrack = parseTracks(vSegs, vInfo);
        const aTrack = aInfo ? parseTracks(aSegs, aInfo) : null;
        if (vTrack.chunks.length === 0 || vTrack.totalDur <= 0) throw new Error('No valid video samples were downloaded');
        if (aTrack && (aTrack.chunks.length === 0 || aTrack.totalDur <= 0)) throw new Error('No valid audio samples were downloaded');
        if (aTrack) {
            const videoStartMs = (vTrack.firstDecodeTime / vInfo.timescale) * 1000;
            const audioStartMs = (aTrack.firstDecodeTime / aInfo.timescale) * 1000;
            if (Math.abs(videoStartMs - audioStartMs) > 1) {
                throw new Error('Video and audio tracks begin at different decode times');
            }
        }
        const vDurMs = (vTrack.totalDur / vInfo.timescale) * 1000;
        const aDurMs = aTrack ? (aTrack.totalDur / aInfo.timescale) * 1000 : 0;
        const movieDurMs = Math.max(vDurMs, aDurMs);
        const movieTs = 1000;
        log('Parsed downloaded media fragments.', {
            videoChunks: vTrack.chunks.length,
            audioChunks: aTrack?.chunks.length || 0,
            durationSeconds: Number((movieDurMs / 1000).toFixed(1)),
        });

        // Build sample tables for a track
        function buildSampleTables(track, trackIsVideo) {
            const sttsRLE = []; // {count, delta}
            const sizes = [];
            const syncs = []; // 1-based indices (video only)
            const ctos = [];  // composition time offsets
            let sampleIdx = 1, lastDur = -1, lastCount = 0;

            for (const chunk of track.chunks) {
                for (const s of chunk.samples) {
                    if (s.dur === lastDur) { lastCount++; } else {
                        if (lastCount > 0) sttsRLE.push({ count: lastCount, delta: lastDur });
                        lastDur = s.dur; lastCount = 1;
                    }
                    sizes.push(s.size);
                    if (trackIsVideo && (s.flags & 0x00010000) === 0) syncs.push(sampleIdx);
                    if (track.anyCTO && trackIsVideo) ctos.push(s.cto);
                    sampleIdx++;
                }
            }
            if (lastCount > 0) sttsRLE.push({ count: lastCount, delta: lastDur });

            // Rebuild stsc properly: group consecutive chunks with same sample count
            const stsc = [];
            for (let i = 0; i < track.chunks.length; i++) {
                const n = track.chunks[i].samples.length;
                if (stsc.length === 0 || stsc[stsc.length - 1].spc !== n) {
                    stsc.push({ fc: i + 1, spc: n }); // 1-based chunk index
                }
            }

            return { sttsRLE, sizes, syncs, ctos, stsc, chunkCount: track.chunks.length };
        }

        const vTables = buildSampleTables(vTrack, true);
        const aTables = aTrack ? buildSampleTables(aTrack, false) : null;

        // Encode sample table boxes
        function encStts(entries) {
            const d = new Uint8Array(4 + entries.length * 8);
            MP4.w32(d, 0, entries.length);
            entries.forEach((e, i) => { MP4.w32(d, 4 + i * 8, e.count); MP4.w32(d, 8 + i * 8, e.delta); });
            return fullBox('stts', 0, 0, d);
        }
        function encStsz(sizes) {
            const d = new Uint8Array(8 + sizes.length * 4);
            MP4.w32(d, 4, sizes.length);
            sizes.forEach((s, i) => MP4.w32(d, 8 + i * 4, s));
            return fullBox('stsz', 0, 0, d);
        }
        function encStss(syncs) {
            const d = new Uint8Array(4 + syncs.length * 4);
            MP4.w32(d, 0, syncs.length);
            syncs.forEach((s, i) => MP4.w32(d, 4 + i * 4, s));
            return fullBox('stss', 0, 0, d);
        }
        function encCtts(offsets) {
            // RLE compress
            const rle = [];
            let last = offsets[0], cnt = 1;
            for (let i = 1; i < offsets.length; i++) {
                if (offsets[i] === last) cnt++;
                else { rle.push({ count: cnt, offset: last }); last = offsets[i]; cnt = 1; }
            }
            rle.push({ count: cnt, offset: last });
            const d = new Uint8Array(4 + rle.length * 8);
            MP4.w32(d, 0, rle.length);
            rle.forEach((e, i) => { MP4.w32(d, 4 + i * 8, e.count); MP4.w32(d, 8 + i * 8, e.offset >>> 0); });
            return fullBox('ctts', 1, 0, d); // version 1 for signed offsets
        }
        function encStsc(entries) {
            const d = new Uint8Array(4 + entries.length * 12);
            MP4.w32(d, 0, entries.length);
            entries.forEach((e, i) => {
                MP4.w32(d, 4 + i * 12, e.fc); MP4.w32(d, 8 + i * 12, e.spc); MP4.w32(d, 12 + i * 12, 1);
            });
            return fullBox('stsc', 0, 0, d);
        }
        // co64 — returns { box, offsets } so we can fill offsets later
        function encCo64(count) {
            const d = new Uint8Array(4 + count * 8);
            MP4.w32(d, 0, count);
            const box = fullBox('co64', 0, 0, d);
            return { box, bodyStart: 16 }; // offset within box where first 64-bit offset lives
        }

        // dinf
        const urlBox = fullBox('url ', 0, 1);
        const drefBody = new Uint8Array(4); MP4.w32(drefBody, 0, 1);
        const dinf = MP4.box('dinf', fullBox('dref', 0, 0, drefBody, urlBox));

        // Build one trak box
        function buildTrak(trackId, trackInfo, tables, duration, isVideoTrack) {
            // tkhd
            const tkBody = new Uint8Array(80);
            MP4.w32(tkBody, 8, trackId);
            MP4.w32(tkBody, 16, Math.round(duration));
            if (!isVideoTrack) { tkBody[32] = 0x01; tkBody[33] = 0x00; } // volume=1.0 for audio
            MP4.w32(tkBody, 36, 0x00010000); MP4.w32(tkBody, 52, 0x00010000); MP4.w32(tkBody, 68, 0x40000000);
            MP4.w32(tkBody, 72, trackInfo.width << 16); MP4.w32(tkBody, 76, trackInfo.height << 16);
            const tkhd = fullBox('tkhd', 0, 3, tkBody);

            // mdhd
            // mdhd version 1 (64-bit fields) needed for high-timescale long videos
            const mediaDur = Math.round(duration / 1000 * trackInfo.timescale);
            // v1 body: creation(8)+modification(8)+timescale(4)+duration(8)+language(2)+pre_defined(2) = 32
            const mdBody = new Uint8Array(32);
            MP4.w32(mdBody, 16, trackInfo.timescale);
            MP4.w32(mdBody, 20, Math.floor(mediaDur / 0x100000000));
            MP4.w32(mdBody, 24, mediaDur >>> 0);
            mdBody[28] = 0x55; mdBody[29] = 0xC4; // language: und
            const mdhd = fullBox('mdhd', 1, 0, mdBody);

            // hdlr
            const hdName = isVideoTrack ? 'VideoHandler\0' : 'SoundHandler\0';
            const hdBytes = new TextEncoder().encode(hdName);
            const hdBody = new Uint8Array(20 + hdBytes.length);
            hdBody[4] = trackInfo.handler.charCodeAt(0); hdBody[5] = trackInfo.handler.charCodeAt(1);
            hdBody[6] = trackInfo.handler.charCodeAt(2); hdBody[7] = trackInfo.handler.charCodeAt(3);
            hdBody.set(hdBytes, 20);
            const hdlr = fullBox('hdlr', 0, 0, hdBody);

            // xmhd
            const xmhd = isVideoTrack ? fullBox('vmhd', 0, 1, new Uint8Array(8)) : fullBox('smhd', 0, 0, new Uint8Array(4));

            // stbl
            const co64 = encCo64(tables.chunkCount);
            const stblParts = [trackInfo.stsdBytes, encStts(tables.sttsRLE), encStsz(tables.sizes), encStsc(tables.stsc), co64.box];
            if (isVideoTrack && tables.syncs.length > 0) stblParts.push(encStss(tables.syncs));
            if (isVideoTrack && tables.ctos.length > 0) stblParts.push(encCtts(tables.ctos));
            const stbl = MP4.box('stbl', ...stblParts);

            const minf = MP4.box('minf', xmhd, dinf, stbl);
            const mdia = MP4.box('mdia', mdhd, hdlr, minf);
            const trak = MP4.box('trak', tkhd, mdia);

            return { trak, co64 };
        }

        const vResult = buildTrak(1, vInfo, vTables, vDurMs, true);
        const aResult = aTrack ? buildTrak(2, aInfo, aTables, aDurMs, false) : null;

        // mvhd
        const mvhdBody = new Uint8Array(96);
        MP4.w32(mvhdBody, 8, movieTs);
        MP4.w32(mvhdBody, 12, Math.round(movieDurMs));
        MP4.w32(mvhdBody, 16, 0x00010000); // rate
        mvhdBody[20] = 0x01; mvhdBody[21] = 0x00; // volume
        MP4.w32(mvhdBody, 32, 0x00010000); MP4.w32(mvhdBody, 48, 0x00010000); MP4.w32(mvhdBody, 64, 0x40000000);
        MP4.w32(mvhdBody, 92, aResult ? 3 : 2);
        const mvhd = fullBox('mvhd', 0, 0, mvhdBody);

        // moov
        const moovParts = [mvhd, vResult.trak];
        if (aResult) moovParts.push(aResult.trak);
        const moov = MP4.box('moov', ...moovParts);

        // ftyp
        const ftyp = MP4.box('ftyp', new Uint8Array([
            0x69,0x73,0x6F,0x6D, 0x00,0x00,0x02,0x00,
            0x69,0x73,0x6F,0x6D, 0x69,0x73,0x6F,0x32, 0x61,0x76,0x63,0x31, 0x6D,0x70,0x34,0x31,
        ]));

        // Calculate total mdat data size
        let totalMdatData = 0;
        for (const c of vTrack.chunks) {
            for (const s of c.samples) {
                totalMdatData += s.size;
                if (!Number.isSafeInteger(totalMdatData)) throw new Error('MP4 media size exceeds the safe integer range');
            }
        }
        let audioDataStart = totalMdatData;
        if (aTrack) {
            for (const c of aTrack.chunks) {
                for (const s of c.samples) {
                    totalMdatData += s.size;
                    if (!Number.isSafeInteger(totalMdatData)) throw new Error('MP4 media size exceeds the safe integer range');
                }
            }
        }

        // mdat header (always use extended size for safety with large files)
        const mdatHdr = new Uint8Array(16);
        MP4.w32(mdatHdr, 0, 1); // size=1 means use extended size
        mdatHdr[4] = 0x6D; mdatHdr[5] = 0x64; mdatHdr[6] = 0x61; mdatHdr[7] = 0x74;
        const totalMdatBox = totalMdatData + 16;
        // Write 64-bit extended size (high 32 bits, low 32 bits)
        MP4.w32(mdatHdr, 8, Math.floor(totalMdatBox / 0x100000000));
        MP4.w32(mdatHdr, 12, totalMdatBox >>> 0);

        // Now fix chunk offsets in co64 boxes
        const mdatDataStart = ftyp.length + moov.length + 16; // ftyp + moov + 16-byte mdat header

        // Patch co64 chunk offsets directly inside the moov buffer
        // (MP4.box copies data, so we must patch the final moov bytes)
        function patchCo64InMoov(moovBuf, trackChunks, baseOffset, trackIndex) {
            // Find the Nth co64 box in moov
            let co64Count = 0;
            function findCo64(buf, start, end) {
                let pos = start;
                while (pos + 8 <= end) {
                    const size = MP4.boxSize(buf, pos, end);
                    if (size < 8) break;
                    const type = MP4.type(buf, pos);
                    if (type === 'co64') {
                        if (co64Count === trackIndex) return pos;
                        co64Count++;
                    }
                    // Recurse into container boxes
                    if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
                        const found = findCo64(buf, pos + 8, pos + size);
                        if (found !== null) return found;
                    }
                    pos += size;
                }
                return null;
            }

            const co64Pos = findCo64(moovBuf, 0, moovBuf.length);
            if (co64Pos === null) throw new Error(`Could not locate chunk offsets for track ${trackIndex}`);

            // co64: header(8) + ver+flags(4) + entry_count(4) + entries(8 each)
            let dataPos = baseOffset;
            let chunkIdx = 0;
            for (const chunk of trackChunks) {
                const off = co64Pos + 16 + chunkIdx * 8;
                MP4.w32(moovBuf, off, Math.floor(dataPos / 0x100000000));
                MP4.w32(moovBuf, off + 4, dataPos >>> 0);
                for (const s of chunk.samples) dataPos += s.size;
                chunkIdx++;
            }
        }

        patchCo64InMoov(moov, vTrack.chunks, mdatDataStart, 0);
        if (aTrack) patchCo64InMoov(moov, aTrack.chunks, mdatDataStart + audioDataStart, 1);

        // Assemble blob parts: ftyp + moov + mdat header + video data + audio data
        const blobParts = [ftyp, moov, mdatHdr];

        // Add video chunk data (extract mdat payload from each segment)
        for (const chunk of vTrack.chunks) {
            const buf = new Uint8Array(vSegs[chunk.segIdx]);
            blobParts.push(buf.slice(chunk.mdatDataOff, chunk.mdatDataOff + chunk.samples.reduce((a, s) => a + s.size, 0)));
        }
        // Add audio chunk data
        if (aTrack) {
            for (const chunk of aTrack.chunks) {
                const buf = new Uint8Array(aSegs[chunk.segIdx]);
                blobParts.push(buf.slice(chunk.mdatDataOff, chunk.mdatDataOff + chunk.samples.reduce((a, s) => a + s.size, 0)));
            }
        }

        const hasAudio = Boolean(aTrack && aTrack.chunks.length > 0);
        log('MP4 transmux complete.', { parts: blobParts.length, hasAudio });
        const blob = new Blob(blobParts, { type: 'video/mp4' });
        return { blob, resolution: `${vInfo.width}x${vInfo.height}`, totalSize: blob.size, hasAudio };
    }

    // ==================== HLS DOWNLOAD ENGINE ====================

    async function downloadHLS(m3u8Url, progressCb, signal) {
        throwIfAborted(signal);
        progressCb('Fetching playlist...', 0);
        const masterContent = await gmFetchText(m3u8Url, signal);

        let videoSegmentUrls, videoInitUrl;
        let audioSegmentUrls = null, audioInitUrl = null;
        let resolution = '';

        if (masterContent.includes('#EXT-X-STREAM-INF:')) {
            const { variants, audioPlaylistUrl: fallbackAudioPlaylistUrl } = parseM3U8Master(masterContent, m3u8Url);
            if (variants.length === 0) throw new Error('No variants found');

            const best = variants[0];
            resolution = best.resolution;
            progressCb(`Fetching ${resolution || 'best'} stream info...`, 0);

            const videoContent = await gmFetchText(best.url, signal);
            const videoParsed = parseM3U8Variant(videoContent, best.url);
            videoSegmentUrls = videoParsed.segments;
            videoInitUrl = videoParsed.initSegmentUrl;

            const audioPlaylistUrl = best.audioPlaylistUrl || fallbackAudioPlaylistUrl;
            if (audioPlaylistUrl) {
                const audioContent = await gmFetchText(audioPlaylistUrl, signal);
                const audioParsed = parseM3U8Variant(audioContent, audioPlaylistUrl);
                audioSegmentUrls = audioParsed.segments;
                audioInitUrl = audioParsed.initSegmentUrl;
                log('Parsed the HLS audio rendition.', { segments: audioSegmentUrls.length, hasInit: !!audioInitUrl });
            }
        } else {
            const parsed = parseM3U8Variant(masterContent, m3u8Url);
            videoSegmentUrls = parsed.segments;
            videoInitUrl = parsed.initSegmentUrl;
        }

        if (videoSegmentUrls.length === 0) throw new Error('No segments found');
        if (!videoInitUrl) throw new Error('No video init segment');
        if (audioSegmentUrls?.length && !audioInitUrl) throw new Error('No audio init segment');

        // Download init segments
        progressCb('Downloading init segments...', 0);
        const videoInitData = await gmFetchRetry(videoInitUrl, signal);
        let audioInitData = null;
        if (audioInitUrl) {
            audioInitData = await gmFetchRetry(audioInitUrl, signal);
        }

        // Build download queue (video + audio segments)
        const hasAudio = audioSegmentUrls && audioSegmentUrls.length > 0;
        const totalSegments = videoSegmentUrls.length + (hasAudio ? audioSegmentUrls.length : 0);
        const videoSegments = new Array(videoSegmentUrls.length);
        const audioSegments = hasAudio ? new Array(audioSegmentUrls.length) : [];

        const queue = [];
        videoSegmentUrls.forEach((url, i) => queue.push({ url, index: i, type: 'v' }));
        if (hasAudio) audioSegmentUrls.forEach((url, i) => queue.push({ url, index: i, type: 'a' }));

        let completed = 0;
        let downloadedBytes = videoInitData.byteLength + (audioInitData?.byteLength || 0);
        let nextQueueIndex = 0, lastProgressAt = 0;
        if (downloadedBytes > MAX_ASSEMBLY_BYTES) {
            throw new Error('This HLS video is too large to assemble safely in one browser tab');
        }
        progressCb(`Downloading 0/${totalSegments} segments...`, 0);

        const CONCURRENCY = 6;
        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
            workers.push((async () => {
                while (nextQueueIndex < queue.length) {
                    throwIfAborted(signal);
                    const item = queue[nextQueueIndex++];
                    if (!item) break;
                    const data = await gmFetchRetry(item.url, signal);
                    throwIfAborted(signal);
                    if (item.type === 'v') videoSegments[item.index] = data;
                    else audioSegments[item.index] = data;
                    completed++;
                    downloadedBytes += data.byteLength;
                    if (downloadedBytes > MAX_ASSEMBLY_BYTES) {
                        throw new Error('This HLS video is too large to assemble safely in one browser tab');
                    }
                    const now = performance.now();
                    if (completed === totalSegments || now - lastProgressAt >= 100) {
                        lastProgressAt = now;
                        const pct = Math.round((completed / totalSegments) * 100);
                        const sizeMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
                        progressCb(`Downloading ${completed}/${totalSegments} segments (${sizeMB} MB)`, pct);
                    }
                }
            })());
        }

        await Promise.all(workers);
        throwIfAborted(signal);

        // Transmux fMP4 segments into standard (non-fragmented) MP4
        return transmuxToMP4(videoInitData, audioInitData, videoSegments, audioSegments, progressCb);
    }

    // ==================== DOWNLOAD HELPERS ====================

    function triggerBlobDownload(blob, filename) {
        if (!(blob instanceof Blob)) blob = new Blob([blob], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return { completed: false, method: 'browser-anchor' };
    }

    function gmDownloadPromise(source, filename, signal = null) {
        return new Promise((resolve, reject) => {
            throwIfAborted(signal);
            if (typeof GM_download !== 'function') {
                reject(new Error('Tampermonkey download API is unavailable'));
                return;
            }
            let handle = null;
            let settled = false;
            const cleanup = () => {
                if (handle) activeRequestHandles.delete(handle);
                signal?.removeEventListener('abort', onAbort);
            };
            const settle = (callback, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback(value);
            };
            const onAbort = () => {
                try { handle?.abort?.(); } catch {}
                settle(reject, makeAbortError());
            };
            try {
                handle = GM_download({
                    url: source,
                    name: filename,
                    conflictAction: 'uniquify',
                    onload: () => settle(resolve, { completed: true, method: 'gm-download' }),
                    onerror: failure => settle(reject, new Error(`Download failed (${failure?.error || 'unknown'})`)),
                    ontimeout: () => settle(reject, new Error('Download timed out')),
                });
                if (!settled) {
                    if (handle) activeRequestHandles.add(handle);
                    if (signal?.aborted) onAbort();
                    else signal?.addEventListener('abort', onAbort, { once: true });
                }
            } catch (error) {
                settle(reject, error);
            }
        });
    }

    async function saveBlob(blob, filename, signal = null) {
        try {
            return await gmDownloadPromise(blob, filename, signal);
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            warn('Tampermonkey could not save the Blob directly; using the browser download fallback.', safeErrorMessage(error));
            throwIfAborted(signal);
            return triggerBlobDownload(blob, filename);
        }
    }

    async function downloadDirect(url, filename, signal = null) {
        try {
            return await gmDownloadPromise(url, filename, signal);
        } catch (firstError) {
            if (firstError?.name === 'AbortError') throw firstError;
            warn('Direct download failed; fetching the MP4 before saving.', safeErrorMessage(firstError));
            const blob = await fetchWithRetry(url, {
                responseType: 'blob', signal, attempts: 3,
                validate: value => value && typeof value.size === 'number' && value.size > 0,
            });
            return saveBlob(blob, filename, signal);
        }
    }

    // ==================== HLS DOWNLOAD ORCHESTRATION ====================

    function safeFilePart(value, fallback) {
        const normalized = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
        return normalized.slice(0, 80) || fallback;
    }

    async function startHLSDownload(m3u8Url, tweetId, player, mediaKey = null) {
        const downloadKey = mediaKey || tweetId || `anonymous-${++anonymousDownloadId}`;
        if (activeDownloads.has(downloadKey)) {
            showToast('This video is already downloading.');
            return { status: 'duplicate' };
        }
        const controller = new AbortController();
        const overlay = createProgressOverlay(player);
        const downloadState = { controller, overlay };
        activeDownloads.set(downloadKey, downloadState);

        overlay.cancelBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            overlay.update('Cancelling...', 0);
            overlay.cancelBtn.disabled = true;
            controller.abort();
        }, { capture: true, once: true });

        try {
            log('HLS download started.');
            const result = await downloadHLS(m3u8Url, (msg, pct) => overlay.update(msg, pct), controller.signal);
            const sizeMB = (result.totalSize / (1024 * 1024)).toFixed(1);
            const filename = `twitter_${safeFilePart(tweetId, 'video')}_${safeFilePart(result.resolution, 'best')}.mp4`;
            overlay.update('Saving MP4...', 100);
            const saved = await saveBlob(result.blob, filename, controller.signal);
            const audioNote = result.hasAudio ? ' with audio' : '';
            const verb = saved.completed ? 'Saved' : 'Save started for';
            showToast(`${verb} ${sizeMB} MB${audioNote} \u2022 ${result.resolution || 'best quality'}`);
            log('HLS download finished.', { bytes: result.totalSize, hasAudio: result.hasAudio, saveConfirmed: saved.completed });
            return { status: 'saved' };
        } catch (error) {
            controller.abort();
            if (error?.name === 'AbortError' || error?.message === 'Cancelled') {
                showToast('Download cancelled.');
                log('Download cancelled.');
                return { status: 'cancelled' };
            } else {
                reportError('HLS download failed:', safeErrorMessage(error));
                return { status: 'failed', error };
            }
        } finally {
            overlay.remove();
            if (activeDownloads.get(downloadKey) === downloadState) activeDownloads.delete(downloadKey);
        }
    }

    // ==================== UI: PROGRESS OVERLAY ====================

    function createProgressOverlay(player) {
        const overlay = document.createElement('div');
        overlay.className = 'vid-dl-progress twitter-video-downloader-progress';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');
        Object.assign(overlay.style, {
            position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', zIndex: '10001',
        });

        const text = document.createElement('div');
        Object.assign(text.style, {
            color: 'white', fontSize: '14px', fontWeight: '600', marginBottom: '14px',
            textAlign: 'center', padding: '0 20px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });
        text.textContent = 'Preparing...';

        const barOuter = document.createElement('div');
        barOuter.setAttribute('role', 'progressbar');
        barOuter.setAttribute('aria-valuemin', '0');
        barOuter.setAttribute('aria-valuemax', '100');
        barOuter.setAttribute('aria-valuenow', '0');
        Object.assign(barOuter.style, {
            width: '80%', maxWidth: '300px', height: '6px',
            background: 'rgba(255,255,255,0.2)', borderRadius: '3px',
            overflow: 'hidden', marginBottom: '14px',
        });
        const barInner = document.createElement('div');
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        Object.assign(barInner.style, {
            width: '0%', height: '100%', background: 'rgb(29,155,240)',
            borderRadius: '3px', transition: reduceMotion ? 'none' : 'width 0.15s ease',
        });
        barOuter.appendChild(barInner);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.setAttribute('aria-label', 'Cancel video download');
        Object.assign(cancelBtn.style, {
            background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)',
            color: 'white', padding: '6px 24px', borderRadius: '18px', cursor: 'pointer',
            fontSize: '13px', fontWeight: '600', transition: 'background 0.15s',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });
        cancelBtn.addEventListener('mouseover', () => { cancelBtn.style.background = 'rgba(255,80,80,0.4)'; }, { signal: uiEvents.signal });
        cancelBtn.addEventListener('mouseout', () => { cancelBtn.style.background = 'rgba(255,255,255,0.12)'; }, { signal: uiEvents.signal });

        overlay.appendChild(text);
        overlay.appendChild(barOuter);
        overlay.appendChild(cancelBtn);
        player.appendChild(overlay);

        return {
            update(msg, pct) {
                if (!overlay.isConnected) return;
                text.textContent = String(msg);
                const progress = Number.isFinite(Number(pct)) ? Math.max(0, Math.min(100, Number(pct))) : 0;
                barInner.style.width = progress + '%';
                barOuter.setAttribute('aria-valuenow', String(progress));
            },
            remove() { overlay.remove(); },
            cancelBtn,
        };
    }

    // ==================== UI: DOWNLOAD BUTTONS ====================

    const BUTTON_CLASS = 'twitter-video-downloader-button';
    const DOWNLOAD_ICON = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-5H7l5-7 5 7h-4v5h-2z" transform="rotate(180 12 12)"/>
        </svg>
        <span style="margin-left:4px">Download</span>`;

    async function startDirectDownload(url, tweetId, resolution, mediaKey = null) {
        const downloadKey = `direct-${mediaKey || tweetId || ++anonymousDownloadId}`;
        if (activeDownloads.has(downloadKey)) {
            showToast('This video is already downloading.');
            return;
        }
        const controller = new AbortController();
        const state = { controller, overlay: null };
        activeDownloads.set(downloadKey, state);
        try {
            showToast('Downloading the best direct MP4...');
            log('Direct MP4 download started.');
            const filename = `twitter_${safeFilePart(tweetId, 'video')}_${safeFilePart(resolution, 'video')}.mp4`;
            const saved = await downloadDirect(url, filename, controller.signal);
            showToast(saved.completed ? 'Direct MP4 saved.' : 'Direct MP4 save started.');
            log('Direct MP4 download finished.', { saveConfirmed: saved.completed });
        } catch (error) {
            if (error?.name !== 'AbortError') {
                reportError('Direct MP4 download failed:', safeErrorMessage(error));
                showToast('Download failed: ' + safeErrorMessage(error));
            }
        } finally {
            if (activeDownloads.get(downloadKey) === state) activeDownloads.delete(downloadKey);
        }
    }

    async function runDownloadForPlayer(player, button = null) {
        if (!player || destroyed) return;
        const tweetId = getTweetIdFromElement(player) || getTweetIdFromUrl(window.location.href);
        let info = getVideoInfoForElement(player);
        log('Download control activated.', {
            cachedVideos: capturedVideos.size,
            hasHls: !!info.m3u8Url,
            directVariants: info.mp4Variants?.length || 0,
        });

        const originalButtonHtml = button?.innerHTML;
        const metadataIsStale = !info.capturedAt || Date.now() - info.capturedAt > 5 * 60 * 1000;
        if (tweetId && (!info.m3u8Url || metadataIsStale)) {
            if (button) {
                button.disabled = true;
                button.setAttribute('aria-busy', 'true');
                button.innerHTML = '<span>Fetching...</span>';
                button.style.opacity = '1';
                button.style.pointerEvents = 'auto';
            }
            try {
                const fetched = await fetchTweetVideoData(tweetId);
                if (fetched) info = getVideoInfoForElement(player);
            } catch (error) {
                reportError('Active video lookup failed:', safeErrorMessage(error));
            } finally {
                if (button?.isConnected) {
                    button.innerHTML = originalButtonHtml;
                    button.disabled = false;
                    button.removeAttribute('aria-busy');
                }
            }
        }

        let hlsFailure = null;
        if (info.m3u8Url) {
            for (let attempt = 0; attempt < 2 && info.m3u8Url; attempt++) {
                const outcome = await startHLSDownload(info.m3u8Url, info.tweetId || tweetId, player, info.mediaKey || info.m3u8Url);
                if (outcome.status !== 'failed') return;
                hlsFailure = outcome.error;
                const refreshTweetId = info.tweetId || tweetId;
                const shouldRefresh = attempt === 0 && refreshTweetId && (hlsFailure?.status === 401 || hlsFailure?.status === 403);
                if (!shouldRefresh) break;
                showToast('The HLS link expired. Refreshing media details once...');
                capturedVideos.delete(refreshTweetId);
                try {
                    const fetched = await fetchTweetVideoData(refreshTweetId);
                    if (!fetched) break;
                    info = getVideoInfoForElement(player);
                } catch (error) {
                    reportError('Media refresh failed:', safeErrorMessage(error));
                    break;
                }
            }
        }
        if (info.mp4Variants?.length > 0) {
            if (hlsFailure) showToast('HLS was unavailable. Trying the best direct MP4...');
            const best = info.mp4Variants[0];
            const resolution = best.url.match(/\/(\d+x\d+)\//)?.[1] || 'video';
            await startDirectDownload(best.url, info.tweetId || tweetId, resolution, info.mediaKey || best.url);
            return;
        }
        if (hlsFailure) {
            showToast('Download failed: ' + safeErrorMessage(hlsFailure));
            return;
        }
        warn('No video URL was available for the selected player.');
        showToast('Could not find a video URL. Try playing the video first.');
    }

    function addDownloadButton(player) {
        if (!player?.isConnected || player.querySelector(`:scope > .${BUTTON_CLASS}`)) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BUTTON_CLASS;
        btn.setAttribute('aria-label', 'Download this video in the best available quality');
        btn.title = 'Download best available video and audio';
        btn.innerHTML = DOWNLOAD_ICON;
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        Object.assign(btn.style, {
            position: 'absolute', top: '8px', right: '8px', zIndex: '9999',
            background: 'rgba(0,0,0,0.75)', color: 'white',
            border: '2px solid rgba(255,255,255,0.3)', borderRadius: '20px',
            padding: '6px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: '700',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            display: 'flex', alignItems: 'center', backdropFilter: 'blur(4px)',
            transition: reduceMotion ? 'none' : 'opacity 0.2s ease, background 0.2s ease, border-color 0.2s ease',
            opacity: '0', pointerEvents: 'none',
        });

        if (getComputedStyle(player).position === 'static') {
            modifiedPlayers.set(player, player.style.position);
            player.style.position = 'relative';
        }
        const showButton = () => { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; };
        const hideButton = () => {
            if (!player.querySelector('.vid-dl-progress') && document.activeElement !== btn) {
                btn.style.opacity = '0'; btn.style.pointerEvents = 'none';
            }
        };
        const listenerOptions = { signal: uiEvents.signal };
        player.addEventListener('pointerenter', showButton, listenerOptions);
        player.addEventListener('pointerleave', hideButton, listenerOptions);
        btn.addEventListener('focus', showButton, listenerOptions);
        btn.addEventListener('blur', hideButton, listenerOptions);
        btn.addEventListener('pointerenter', showButton, listenerOptions);
        btn.addEventListener('pointerover', () => {
            btn.style.background = 'rgba(29,155,240,0.9)';
            btn.style.borderColor = 'rgba(29,155,240,1)';
        }, listenerOptions);
        btn.addEventListener('pointerout', () => {
            btn.style.background = 'rgba(0,0,0,0.75)';
            btn.style.borderColor = 'rgba(255,255,255,0.3)';
        }, listenerOptions);
        btn.addEventListener('click', async event => {
            event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
            await runDownloadForPlayer(player, btn);
        }, { capture: true, signal: uiEvents.signal });
        player.appendChild(btn);
    }

    function addDownloadButtons(root = document) {
        if (destroyed || !root?.querySelectorAll) return;
        if (root.nodeType === Node.ELEMENT_NODE && root.matches?.('[data-testid="videoPlayer"]')) addDownloadButton(root);
        root.querySelectorAll('[data-testid="videoPlayer"]').forEach(addDownloadButton);
    }

    function scheduleButtonScan(root = document) {
        if (destroyed) return;
        if (root === document) {
            pendingScanRoots.clear();
            pendingScanRoots.add(document);
        } else if (!pendingScanRoots.has(document) && root?.nodeType === Node.ELEMENT_NODE) {
            pendingScanRoots.add(root);
            if (pendingScanRoots.size > 100) {
                pendingScanRoots.clear();
                pendingScanRoots.add(document);
            }
        }
        if (scanFrame !== null) return;
        scanFrame = requestAnimationFrame(() => {
            scanFrame = null;
            const roots = [...pendingScanRoots];
            pendingScanRoots.clear();
            for (const player of modifiedPlayers.keys()) {
                if (!player?.isConnected) modifiedPlayers.delete(player);
            }
            for (const scanRoot of roots) {
                if (scanRoot === document || scanRoot?.isConnected) addDownloadButtons(scanRoot);
            }
        });
    }

    // ==================== UI: TOAST ====================

    function showToast(message) {
        clearTimeout(toastTimer);
        clearTimeout(toastRemovalTimer);
        const existing = document.getElementById('twitter-video-downloader-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'twitter-video-downloader-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.textContent = message;
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(29,155,240,0.95)', color: 'white', padding: '12px 24px',
            borderRadius: '24px', fontSize: '14px', fontWeight: '600', zIndex: '99999',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)', transition: reduceMotion ? 'none' : 'opacity 0.3s ease',
            maxWidth: 'min(520px, calc(100vw - 32px))', whiteSpace: 'normal', textAlign: 'center',
            overflowWrap: 'anywhere', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });
        document.body.appendChild(toast);
        toastTimer = setTimeout(() => {
            toast.style.opacity = '0';
            toastRemovalTimer = setTimeout(() => toast.remove(), reduceMotion ? 0 : 300);
        }, 3500);
    }

    // ==================== KEYBOARD SHORTCUT ====================

    async function onKeyboardShortcut(event) {
        if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.code !== 'KeyD') return;
        if (event.repeat || event.defaultPrevented) return;
        const target = event.target;
        if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();

        const videos = [...document.querySelectorAll('[data-testid="videoPlayer"] video')];
        if (videos.length === 0) {
            showToast('No video found on this page.');
            return;
        }
        let bestVideo = null;
        let bestScore = 0;
        for (const video of videos) {
            const rect = video.getBoundingClientRect();
            const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
            const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
            const score = visibleWidth * visibleHeight;
            if (score > bestScore) { bestScore = score; bestVideo = video; }
        }
        const player = bestVideo?.closest('[data-testid="videoPlayer"]');
        if (!player) {
            showToast('No visible video player found.');
            return;
        }
        log('Keyboard download shortcut activated.');
        await runDownloadForPlayer(player, player.querySelector(`:scope > .${BUTTON_CLASS}`));
    }

    document.addEventListener('keydown', onKeyboardShortcut, { signal: uiEvents.signal });

    // ==================== INITIALIZATION ====================

    function init() {
        if (destroyed || !document.body) return;
        log(`X/Twitter Video Downloader v${SCRIPT_VERSION} loaded.`);
        addDownloadButtons(document);
        mutationObserver = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) scheduleButtonScan(node);
                }
            }
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    function destroy(reason = 'manual') {
        if (destroyed) return;
        destroyed = true;
        mutationObserver?.disconnect();
        mutationObserver = null;
        if (scanFrame !== null) cancelAnimationFrame(scanFrame);
        scanFrame = null;
        pendingScanRoots.clear();
        clearTimeout(toastTimer);
        clearTimeout(toastRemovalTimer);
        uiEvents.abort();

        for (const state of activeDownloads.values()) state.controller?.abort();
        activeDownloads.clear();
        for (const handle of [...activeRequestHandles]) {
            try { handle?.abort?.(); } catch {}
        }
        activeRequestHandles.clear();

        if (pageWindow.fetch === fetchWrapper) pageWindow.fetch = originalFetch;
        if (XHR.open === xhrOpenWrapper) XHR.open = originalXhrOpen;
        if (XHR.send === xhrSendWrapper) XHR.send = originalXhrSend;
        if (XHR.setRequestHeader === xhrSetHeaderWrapper) XHR.setRequestHeader = originalXhrSetHeader;

        document.querySelectorAll(`.${BUTTON_CLASS}, .twitter-video-downloader-progress, #twitter-video-downloader-toast`).forEach(node => node.remove());
        for (const [player, originalPosition] of modifiedPlayers) {
            if (player?.style) player.style.position = originalPosition;
        }
        modifiedPlayers.clear();
        capturedVideos.clear();
        capturedAuth = null;
        capturedTweetEndpoint = null;
        try {
            if (pageWindow[INSTANCE_KEY] === instance) delete pageWindow[INSTANCE_KEY];
        } catch {}
        log('Userscript resources cleaned up.', { reason });
    }

    window.addEventListener('pagehide', event => {
        if (!event.persisted) destroy('pagehide');
    }, { once: true, signal: uiEvents.signal });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true, signal: uiEvents.signal });
    else init();
})();
