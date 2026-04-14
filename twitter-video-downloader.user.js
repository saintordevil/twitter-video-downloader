// ==UserScript==
// @name         X/Twitter Video Downloader
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  One-click best quality video+audio download from X/Twitter via HLS
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      video.twimg.com
// @connect      x.com
// @connect      twitter.com
// @connect      api.x.com
// @connect      api.twitter.com
// @connect      cdn.syndication.twimg.com
// @connect      pbs.twimg.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ==================== DATA STORAGE ====================

    const capturedVideos = new Map();
    const activeDownloads = new Map();
    let capturedAuth = null;
    let capturedTweetEndpoint = null;
    const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    // Use the page's real window (not Tampermonkey's sandbox)
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    console.log('[VidDL] unsafeWindow available:', typeof unsafeWindow !== 'undefined');
    console.log('[VidDL] pageWindow === window:', pageWindow === window);

    // ==================== NETWORK INTERCEPTORS ====================

    let fetchInterceptCount = 0;
    const originalFetch = pageWindow.fetch.bind(pageWindow);
    pageWindow.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        try {
            const init = args[1] || {};
            if (url.includes('/i/api/graphql/') || url.includes('/i/api/1.1/')) {
                const headers = extractHeadersObj(init.headers);
                if (headers['authorization'] || headers['x-csrf-token']) {
                    capturedAuth = headers;
                    console.log('[VidDL] Captured auth headers from fetch');
                }
                if (url.includes('TweetResultByRestId')) {
                    capturedTweetEndpoint = url.split('?')[0];
                    console.log('[VidDL] Captured TweetResultByRestId endpoint:', capturedTweetEndpoint);
                }
            }
        } catch (e) { console.warn('[VidDL] Fetch pre-intercept error:', e); }

        const response = await originalFetch.apply(this, args);
        try {
            if (url.includes('/graphql/') || url.includes('TweetDetail') || url.includes('Timeline') ||
                url.includes('TweetResultByRestId') || url.includes('Likes') || url.includes('Bookmark')) {
                fetchInterceptCount++;
                console.log(`[VidDL] Intercepted fetch #${fetchInterceptCount}: ${url.substring(0, 120)}`);
                const clone = response.clone();
                clone.json().then(json => {
                    const before = capturedVideos.size;
                    extractVideoUrls(json);
                    if (capturedVideos.size > before) {
                        console.log(`[VidDL] New videos captured! Total: ${capturedVideos.size}`, [...capturedVideos.keys()]);
                    }
                }).catch(() => {});
            }
        } catch (e) { console.warn('[VidDL] Fetch post-intercept error:', e); }
        return response;
    };

    const XHR = pageWindow.XMLHttpRequest.prototype;
    const originalXhrOpen = XHR.open;
    const originalXhrSend = XHR.send;
    const originalXhrSetHeader = XHR.setRequestHeader;
    XHR.open = function (method, url, ...rest) {
        this._url = url; this._headers = {};
        return originalXhrOpen.call(this, method, url, ...rest);
    };
    XHR.setRequestHeader = function (name, value) {
        if (this._headers) this._headers[name.toLowerCase()] = value;
        return originalXhrSetHeader.call(this, name, value);
    };
    XHR.send = function (...args) {
        this.addEventListener('load', function () {
            try {
                const url = this._url || '';
                if ((url.includes('/i/api/graphql/') || url.includes('/i/api/1.1/')) && this._headers) {
                    if (this._headers['authorization'] || this._headers['x-csrf-token']) capturedAuth = this._headers;
                    if (url.includes('TweetResultByRestId')) capturedTweetEndpoint = url.split('?')[0];
                }
                if (url.includes('/graphql/') || url.includes('TweetDetail') || url.includes('Timeline')) {
                    console.log('[VidDL] Intercepted XHR:', url.substring(0, 120));
                    extractVideoUrls(JSON.parse(this.responseText));
                }
            } catch (e) { console.warn('[VidDL] XHR intercept error:', e); }
        });
        return originalXhrSend.apply(this, args);
    };

    function extractHeadersObj(headers) {
        const result = {};
        if (!headers) return result;
        if (headers instanceof Headers) { headers.forEach((v, k) => { result[k.toLowerCase()] = v; }); }
        else if (Array.isArray(headers)) { headers.forEach(([k, v]) => { result[k.toLowerCase()] = v; }); }
        else { Object.entries(headers).forEach(([k, v]) => { result[k.toLowerCase()] = v; }); }
        return result;
    }

    // ==================== DATA EXTRACTION ====================

    function extractVideoUrls(obj, tweetId = null) {
        if (!obj || typeof obj !== 'object') return;
        if (obj.rest_id && typeof obj.rest_id === 'string') tweetId = obj.rest_id;
        if (obj.id_str && typeof obj.id_str === 'string') tweetId = obj.id_str;

        if (obj.video_info && obj.video_info.variants) {
            const m3u8 = obj.video_info.variants.find(v => v.content_type === 'application/x-mpegURL');
            const mp4s = obj.video_info.variants
                .filter(v => v.content_type === 'video/mp4')
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            if (tweetId && (m3u8 || mp4s.length > 0)) {
                const existing = capturedVideos.get(tweetId) || {};
                capturedVideos.set(tweetId, {
                    mp4Variants: mp4s.length > 0 ? mp4s : (existing.mp4Variants || []),
                    m3u8Url: m3u8?.url || existing.m3u8Url || null,
                });
                console.log(`[VidDL] Captured tweet ${tweetId}: M3U8=${!!m3u8}, MP4s=${mp4s.length}`);
            }
        }
        if (Array.isArray(obj)) { obj.forEach(item => extractVideoUrls(item, tweetId)); }
        else { Object.values(obj).forEach(val => extractVideoUrls(val, tweetId)); }
    }

    // Direct search for video_info in any JSON structure (fallback when tweet IDs don't match)
    function findFirstVideoInfoInJson(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.video_info && obj.video_info.variants) {
            const m3u8 = obj.video_info.variants.find(v => v.content_type === 'application/x-mpegURL');
            const mp4s = obj.video_info.variants
                .filter(v => v.content_type === 'video/mp4')
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            if (m3u8 || mp4s.length > 0) {
                return { mp4Variants: mp4s, m3u8Url: m3u8?.url || null };
            }
        }
        const items = Array.isArray(obj) ? obj : Object.values(obj);
        for (const val of items) {
            const found = findFirstVideoInfoInJson(val);
            if (found) return found;
        }
        return null;
    }

    // ==================== ACTIVE API FETCH ====================

    function getCsrfToken() {
        const m = document.cookie.match(/ct0=([^;]+)/);
        return m ? m[1] : '';
    }

    function getAuthHeaders() {
        if (capturedAuth && (capturedAuth['authorization'] || capturedAuth['x-csrf-token'])) {
            return {
                'authorization': capturedAuth['authorization'] || `Bearer ${BEARER_TOKEN}`,
                'x-csrf-token': capturedAuth['x-csrf-token'] || getCsrfToken(),
                'x-twitter-active-user': 'yes',
                'x-twitter-auth-type': 'OAuth2Session',
            };
        }
        const csrf = getCsrfToken();
        if (!csrf) return null;
        return { 'authorization': `Bearer ${BEARER_TOKEN}`, 'x-csrf-token': csrf, 'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session' };
    }

    async function fetchTweetVideoData(tweetId) {
        const authHeaders = getAuthHeaders();
        console.log('[VidDL] Active fetch for tweet:', tweetId);
        console.log('[VidDL] Auth available:', !!authHeaders, '| capturedAuth:', !!capturedAuth, '| csrf cookie:', !!getCsrfToken());
        console.log('[VidDL] Captured endpoint:', capturedTweetEndpoint || '(none, using fallback)');
        if (!authHeaders) { console.warn('[VidDL] No auth headers - cannot fetch'); return null; }
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
            const base = capturedTweetEndpoint || 'https://x.com/i/api/graphql/xOhkmRac04YFZmOzU9PJHg/TweetResultByRestId';
            const apiUrl = `${base}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}&fieldToggles=${encodeURIComponent(fieldToggles)}`;
            console.log('[VidDL] Fetching:', apiUrl.substring(0, 100) + '...');
            const response = await originalFetch.call(pageWindow, apiUrl, { method: 'GET', headers: authHeaders, credentials: 'include' });
            console.log('[VidDL] API response status:', response.status, response.statusText);
            if (response.ok) {
                const data = await response.json();
                extractVideoUrls(data, tweetId);
                let result = capturedVideos.get(tweetId) || null;
                // If video was stored under a different ID (retweet/quote tweet/embedded),
                // directly search the response for video_info
                if (!result) {
                    console.log('[VidDL] Not found under requested ID, scanning response directly...');
                    result = findFirstVideoInfoInJson(data);
                    if (result) {
                        capturedVideos.set(tweetId, result);
                        console.log('[VidDL] Found video in response, stored under requested tweet ID');
                    }
                }
                console.log('[VidDL] After API extract:', result ? `M3U8=${!!result.m3u8Url}, MP4s=${result.mp4Variants?.length}` : 'nothing found');
                return result;
            } else {
                const errText = await response.text().catch(() => '');
                console.error('[VidDL] API error response:', errText.substring(0, 300));
            }
        } catch (e) { console.error('[VidDL] GraphQL fetch exception:', e); }
        console.log('[VidDL] Trying syndication API fallback...');
        try {
            const text = await gmFetchText(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`);
            console.log('[VidDL] Syndication response length:', text.length);
            extractVideoUrls(JSON.parse(text), tweetId);
            const result = capturedVideos.get(tweetId) || null;
            console.log('[VidDL] Syndication result:', result ? `M3U8=${!!result.m3u8Url}, MP4s=${result.mp4Variants?.length}` : 'nothing');
            return result;
        } catch (e) { console.error('[VidDL] Syndication fallback failed:', e); }
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

    function findVideoInfo(element) {
        const tweetId = getTweetIdFromElement(element);
        if (tweetId && capturedVideos.has(tweetId)) return { tweetId, ...capturedVideos.get(tweetId) };
        return { tweetId: tweetId || null, mp4Variants: [], m3u8Url: null };
    }

    // ==================== M3U8 PARSING ====================

    function parseM3U8Master(content, baseUrl) {
        const lines = content.split('\n');
        const variants = [];
        let audioPlaylistUrl = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Audio rendition
            if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
                const m = line.match(/URI="([^"]+)"/);
                if (m) audioPlaylistUrl = new URL(m[1], baseUrl).href;
            }
            // Video variants
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0');
                const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1] || '';
                for (let j = i + 1; j < lines.length; j++) {
                    const next = lines[j].trim();
                    if (next && !next.startsWith('#')) {
                        variants.push({ bandwidth, resolution, url: new URL(next, baseUrl).href });
                        break;
                    }
                }
            }
        }
        return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth), audioPlaylistUrl };
    }

    function parseM3U8Variant(content, baseUrl) {
        const lines = content.split('\n');
        const segments = [];
        let initSegmentUrl = null;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#EXT-X-MAP:')) {
                const m = trimmed.match(/URI="([^"]+)"/);
                if (m) initSegmentUrl = new URL(m[1], baseUrl).href;
            } else if (trimmed && !trimmed.startsWith('#')) {
                segments.push(new URL(trimmed, baseUrl).href);
            }
        }
        return { segments, initSegmentUrl };
    }

    // ==================== FETCH HELPERS ====================

    function gmFetchText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({ method: 'GET', url, onload: r => {
                if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                else reject(new Error(`HTTP ${r.status}`));
            }, onerror: reject, ontimeout: () => reject(new Error('Timeout')) });
        });
    }
    function gmFetchArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({ method: 'GET', url, responseType: 'arraybuffer', onload: r => {
                if (r.status >= 200 && r.status < 300 && r.response && r.response.byteLength > 0) {
                    resolve(r.response);
                } else {
                    reject(new Error(`HTTP ${r.status}, ${r.response?.byteLength || 0} bytes`));
                }
            }, onerror: reject, ontimeout: () => reject(new Error('Timeout')), timeout: 30000 });
        });
    }

    async function gmFetchRetry(url, retries = 5) {
        for (let i = 0; i < retries; i++) {
            try {
                const data = await gmFetchArrayBuffer(url);
                if (validateSegment(data)) return data;
                console.warn(`[VidDL] Segment validation failed (attempt ${i + 1}), ${data.byteLength} bytes, retrying...`);
            } catch (e) {
                if (i === retries - 1) throw e;
                console.warn(`[VidDL] Segment fetch error (attempt ${i + 1}): ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        }
        // Last attempt - return whatever we get (better than nothing for long videos)
        console.warn('[VidDL] Final retry, accepting without validation');
        return await gmFetchArrayBuffer(url);
    }

    // ==================== fMP4 BOX UTILITIES ====================

    const MP4 = {
        u32(buf, off) { return (buf[off] << 24 | buf[off+1] << 16 | buf[off+2] << 8 | buf[off+3]) >>> 0; },
        w32(buf, off, val) { buf[off] = (val >> 24) & 0xff; buf[off+1] = (val >> 16) & 0xff; buf[off+2] = (val >> 8) & 0xff; buf[off+3] = val & 0xff; },
        type(buf, off) { return String.fromCharCode(buf[off+4], buf[off+5], buf[off+6], buf[off+7]); },
        boxSize(buf, off, end) { const s = MP4.u32(buf, off); return s === 0 ? end - off : s; },

        findBox(buf, type, start, end) {
            let pos = start;
            while (pos + 8 <= end) {
                const size = MP4.boxSize(buf, pos, end);
                if (size < 8) break;
                if (MP4.type(buf, pos) === type) return { offset: pos, size };
                pos += size;
            }
            return null;
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
        if (!data || data.byteLength < 8) return false;
        const buf = new Uint8Array(data);
        const firstBoxType = MP4.type(buf, 0);
        if (firstBoxType !== 'styp' && firstBoxType !== 'moof' && firstBoxType !== 'ftyp') return false;
        const firstBoxSize = MP4.boxSize(buf, 0, buf.length);
        if (firstBoxSize < 8 || firstBoxSize > buf.length) return false;
        return true;
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

        const trak = MP4.findBox(buf, 'trak', ms, me);
        const ts = trak.offset + 8, te = trak.offset + trak.size;

        // tkhd → dimensions
        const tkhd = MP4.findBox(buf, 'tkhd', ts, te);
        const width = MP4.u32(buf, tkhd.offset + tkhd.size - 8) >>> 16;
        const height = MP4.u32(buf, tkhd.offset + tkhd.size - 4) >>> 16;

        // mdia → mdhd (timescale), hdlr (handler), stsd (codec config)
        const mdia = MP4.findBox(buf, 'mdia', ts, te);
        const mds = mdia.offset + 8, mde = mdia.offset + mdia.size;

        const mdhd = MP4.findBox(buf, 'mdhd', mds, mde);
        const mdVer = buf[mdhd.offset + 8];
        const timescale = MP4.u32(buf, mdhd.offset + (mdVer === 1 ? 28 : 20));

        const hdlr = MP4.findBox(buf, 'hdlr', mds, mde);
        const handler = String.fromCharCode(buf[hdlr.offset + 16], buf[hdlr.offset + 17], buf[hdlr.offset + 18], buf[hdlr.offset + 19]);

        const minf = MP4.findBox(buf, 'minf', mds, mde);
        const stbl = MP4.findBox(buf, 'stbl', minf.offset + 8, minf.offset + minf.size);
        const stsd = MP4.findBox(buf, 'stsd', stbl.offset + 8, stbl.offset + stbl.size);
        const stsdBytes = buf.slice(stsd.offset, stsd.offset + stsd.size);

        // Parse trex (Track Extends) for default sample values
        const mvex = MP4.findBox(buf, 'mvex', ms, me);
        let trex = { dur: 0, size: 0, flags: 0 };
        if (mvex) {
            const trexBox = MP4.findBox(buf, 'trex', mvex.offset + 8, mvex.offset + mvex.size);
            if (trexBox) {
                // trex: header(8) + ver+flags(4) + track_id(4) + desc_idx(4) + def_dur(4) + def_size(4) + def_flags(4)
                trex = {
                    dur: MP4.u32(buf, trexBox.offset + 20),
                    size: MP4.u32(buf, trexBox.offset + 24),
                    flags: MP4.u32(buf, trexBox.offset + 28),
                };
            }
        }
        console.log(`[VidDL] parseTrackInfo: handler=${handler}, timescale=${timescale}, trex.dur=${trex.dur}, trex.size=${trex.size}`);

        return { timescale, handler, stsdBytes, width, height, trex };
    }

    // Parse sample metadata from one fMP4 media segment (moof+mdat)
    function parseFragmentSamples(segData, trexDefaults) {
        const buf = new Uint8Array(segData);
        let pos = 0;
        // Skip to moof
        while (pos + 8 <= buf.length && MP4.type(buf, pos) !== 'moof') pos += MP4.boxSize(buf, pos, buf.length);
        if (pos + 8 > buf.length) return null;

        const moofEnd = pos + MP4.boxSize(buf, pos, buf.length);
        const traf = MP4.findBox(buf, 'traf', pos + 8, moofEnd);
        if (!traf) return null;
        const trafEnd = traf.offset + traf.size;

        // tfhd defaults (fall back to trex defaults from init segment)
        const tfhd = MP4.findBox(buf, 'tfhd', traf.offset + 8, trafEnd);
        const fl = (buf[tfhd.offset + 9] << 16) | (buf[tfhd.offset + 10] << 8) | buf[tfhd.offset + 11];
        let p = tfhd.offset + 16; // past header(8)+ver+flags(4)+track_id(4)
        if (fl & 0x02) p += 8;  // base_data_offset
        if (fl & 0x08) p += 4;  // sample_description_index
        const defDur  = (fl & 0x10) ? (MP4.u32(buf, p) + (p += 4, 0)) : trexDefaults.dur;
        const defSize = (fl & 0x20) ? (MP4.u32(buf, p) + (p += 4, 0)) : trexDefaults.size;
        const defFlag = (fl & 0x40) ? MP4.u32(buf, p) : trexDefaults.flags;

        // trun samples
        const trun = MP4.findBox(buf, 'trun', traf.offset + 8, trafEnd);
        if (!trun) return null;
        const trVer = buf[trun.offset + 8];
        const trFl = (buf[trun.offset + 9] << 16) | (buf[trun.offset + 10] << 8) | buf[trun.offset + 11];
        let tp = trun.offset + 12;
        const count = MP4.u32(buf, tp); tp += 4;
        if (trFl & 0x01) tp += 4; // data_offset
        const firstFlags = (trFl & 0x04) ? MP4.u32(buf, (tp += 4, tp - 4)) : -1;

        const hD = !!(trFl & 0x100), hS = !!(trFl & 0x200), hF = !!(trFl & 0x400), hC = !!(trFl & 0x800);
        const samples = [];
        let anyCTO = false;
        for (let i = 0; i < count; i++) {
            const dur = hD ? MP4.u32(buf, (tp += 4, tp - 4)) : defDur;
            const size = hS ? MP4.u32(buf, (tp += 4, tp - 4)) : defSize;
            let flags;
            if (i === 0 && firstFlags >= 0) { flags = firstFlags; if (hF) tp += 4; }
            else { flags = hF ? MP4.u32(buf, (tp += 4, tp - 4)) : defFlag; }
            let cto = 0;
            if (hC) { cto = MP4.u32(buf, tp); tp += 4; if (trVer === 1 && cto > 0x7FFFFFFF) cto -= 0x100000000; }
            if (cto !== 0) anyCTO = true;
            samples.push({ dur, size, flags, cto });
        }

        // Find mdat data
        pos = moofEnd;
        while (pos + 8 <= buf.length && MP4.type(buf, pos) !== 'mdat') pos += MP4.boxSize(buf, pos, buf.length);
        const mdatBoxSize = MP4.boxSize(buf, pos, buf.length);
        const mdatHdr = (mdatBoxSize === 1 || MP4.u32(buf, pos) === 1) ? 16 : 8;
        const mdatDataOff = pos + mdatHdr;

        return { samples, mdatDataOff, anyCTO };
    }

    // Build a standard (non-fragmented) MP4 from fMP4 init + segments
    function transmuxToMP4(vInitData, aInitData, vSegs, aSegs, progressCb) {
        progressCb('Building standard MP4...', 100);

        const vInfo = parseTrackInfo(vInitData);
        const aInfo = aInitData ? parseTrackInfo(aInitData) : null;
        console.log(`[VidDL] Transmux: video ${vInfo.width}x${vInfo.height} ts=${vInfo.timescale}, audio ts=${aInfo?.timescale || 'none'}`);

        // Parse all segments to extract sample metadata and mdat references
        function parseTracks(segs, info) {
            const chunks = []; // { sampleMeta[], segIndex, mdatDataOff }
            let totalDur = 0, anyCTO = false;
            for (let i = 0; i < segs.length; i++) {
                if (!segs[i]) continue;
                const f = parseFragmentSamples(segs[i], info.trex);
                if (!f || f.samples.length === 0) continue;
                chunks.push({ samples: f.samples, segIdx: i, mdatDataOff: f.mdatDataOff });
                for (const s of f.samples) totalDur += s.dur;
                if (f.anyCTO) anyCTO = true;
            }
            return { chunks, totalDur, anyCTO, info };
        }

        const vTrack = parseTracks(vSegs, vInfo);
        const aTrack = aInfo ? parseTracks(aSegs, aInfo) : null;
        const vDurMs = (vTrack.totalDur / vInfo.timescale) * 1000;
        const aDurMs = aTrack ? (aTrack.totalDur / aInfo.timescale) * 1000 : 0;
        const movieDurMs = Math.max(vDurMs, aDurMs);
        const movieTs = 1000;
        console.log(`[VidDL] Transmux: ${vTrack.chunks.length} video chunks (${(vDurMs/1000).toFixed(1)}s), ${aTrack?.chunks.length || 0} audio chunks (${(aDurMs/1000).toFixed(1)}s)`);

        // Build sample tables for a track
        function buildSampleTables(track, trackIsVideo) {
            const sttsRLE = []; // {count, delta}
            const sizes = [];
            const syncs = []; // 1-based indices (video only)
            const ctos = [];  // composition time offsets
            const stscEntries = []; // {firstChunk, samplesPerChunk}
            let sampleIdx = 1, lastDur = -1, lastCount = 0;

            for (const chunk of track.chunks) {
                const n = chunk.samples.length;
                if (stscEntries.length === 0 || stscEntries[stscEntries.length - 1].spc !== n) {
                    stscEntries.push({ fc: stscEntries.length === 0 ? 1 : stscEntries[stscEntries.length - 1].fc + 1, spc: n });
                }
                // Fix: stsc firstChunk should be 1-based chunk index
                stscEntries[stscEntries.length - 1].fc = stscEntries.length; // Will recalculate below

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
            MP4.w32(tkBody, 36, 0x00010000); MP4.w32(tkBody, 52, 0x00010000); MP4.w32(tkBody, 64, 0x40000000);
            MP4.w32(tkBody, 68, trackInfo.width << 16); MP4.w32(tkBody, 72, trackInfo.height << 16);
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

        const vResult = buildTrak(1, vInfo, vTables, movieDurMs, true);
        const aResult = aTrack ? buildTrak(2, aInfo, aTables, movieDurMs, false) : null;

        // mvhd
        const mvhdBody = new Uint8Array(96);
        MP4.w32(mvhdBody, 8, movieTs);
        MP4.w32(mvhdBody, 12, Math.round(movieDurMs));
        MP4.w32(mvhdBody, 16, 0x00010000); // rate
        mvhdBody[20] = 0x01; mvhdBody[21] = 0x00; // volume
        MP4.w32(mvhdBody, 32, 0x00010000); MP4.w32(mvhdBody, 48, 0x00010000); MP4.w32(mvhdBody, 60, 0x40000000);
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
            for (const s of c.samples) totalMdatData += s.size;
        }
        let audioDataStart = totalMdatData;
        if (aTrack) {
            for (const c of aTrack.chunks) {
                for (const s of c.samples) totalMdatData += s.size;
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
            if (co64Pos === null) { console.error('[VidDL] Could not find co64 in moov for track', trackIndex); return; }

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

        const hasAudio = aTrack && aTrack.chunks.length > 0;
        console.log(`[VidDL] Transmux complete: ${blobParts.length} parts, hasAudio=${hasAudio}`);
        const blob = new Blob(blobParts, { type: 'video/mp4' });
        return { blob, resolution: `${vInfo.width}x${vInfo.height}`, totalSize: blob.size, hasAudio };
    }

    // ==================== HLS DOWNLOAD ENGINE ====================

    async function downloadHLS(m3u8Url, progressCb, cancelToken) {
        progressCb('Fetching playlist...', 0);
        const masterContent = await gmFetchText(m3u8Url);

        let videoSegmentUrls, videoInitUrl;
        let audioSegmentUrls = null, audioInitUrl = null;
        let resolution = '';

        if (masterContent.includes('#EXT-X-STREAM-INF:')) {
            const { variants, audioPlaylistUrl } = parseM3U8Master(masterContent, m3u8Url);
            if (variants.length === 0) throw new Error('No variants found');

            const best = variants[0];
            resolution = best.resolution;
            progressCb(`Fetching ${resolution} stream info...`, 0);

            const videoContent = await gmFetchText(best.url);
            const videoParsed = parseM3U8Variant(videoContent, best.url);
            videoSegmentUrls = videoParsed.segments;
            videoInitUrl = videoParsed.initSegmentUrl;

            if (audioPlaylistUrl) {
                const audioContent = await gmFetchText(audioPlaylistUrl);
                const audioParsed = parseM3U8Variant(audioContent, audioPlaylistUrl);
                audioSegmentUrls = audioParsed.segments;
                audioInitUrl = audioParsed.initSegmentUrl;
                console.log(`[VidDL] Audio stream: ${audioSegmentUrls.length} segments, init=${!!audioInitUrl}`);
            }
        } else {
            const parsed = parseM3U8Variant(masterContent, m3u8Url);
            videoSegmentUrls = parsed.segments;
            videoInitUrl = parsed.initSegmentUrl;
        }

        if (videoSegmentUrls.length === 0) throw new Error('No segments found');

        // Download init segments
        let videoInitData = null, audioInitData = null;
        if (videoInitUrl) {
            progressCb('Downloading init segments...', 0);
            videoInitData = await gmFetchRetry(videoInitUrl);
        }
        if (audioInitUrl) {
            audioInitData = await gmFetchRetry(audioInitUrl);
        }

        // Build download queue (video + audio segments)
        const hasAudio = audioSegmentUrls && audioSegmentUrls.length > 0;
        const totalSegments = videoSegmentUrls.length + (hasAudio ? audioSegmentUrls.length : 0);
        const videoSegments = new Array(videoSegmentUrls.length);
        const audioSegments = hasAudio ? new Array(audioSegmentUrls.length) : [];

        const queue = [];
        videoSegmentUrls.forEach((url, i) => queue.push({ url, index: i, type: 'v' }));
        if (hasAudio) audioSegmentUrls.forEach((url, i) => queue.push({ url, index: i, type: 'a' }));

        let completed = 0, downloadedBytes = 0;
        progressCb(`Downloading 0/${totalSegments} segments...`, 0);

        const CONCURRENCY = 6;
        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
            workers.push((async () => {
                while (queue.length > 0) {
                    if (cancelToken.cancelled) throw new Error('Cancelled');
                    const item = queue.shift();
                    if (!item) break;
                    const data = await gmFetchRetry(item.url);
                    if (item.type === 'v') videoSegments[item.index] = data;
                    else audioSegments[item.index] = data;
                    completed++;
                    downloadedBytes += data.byteLength;
                    const pct = Math.round((completed / totalSegments) * 100);
                    const sizeMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
                    progressCb(`Downloading ${completed}/${totalSegments} segments (${sizeMB} MB)`, pct);
                }
            })());
        }

        await Promise.all(workers);
        if (cancelToken.cancelled) throw new Error('Cancelled');

        // Transmux fMP4 segments into standard (non-fragmented) MP4
        if (!videoInitData) throw new Error('No video init segment');
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
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function downloadDirect(url, filename) {
        if (typeof GM_download === 'function') {
            GM_download({ url, name: filename, onerror: () => {
                GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob',
                    onload: r => triggerBlobDownload(r.response, filename),
                    onerror: () => window.open(url, '_blank'),
                });
            }});
        } else {
            window.open(url, '_blank');
        }
    }

    // ==================== HLS DOWNLOAD ORCHESTRATION ====================

    async function startHLSDownload(m3u8Url, tweetId, player) {
        const cancelToken = { cancelled: false };
        const overlay = createProgressOverlay(player);
        activeDownloads.set(tweetId, cancelToken);

        overlay.cancelBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            cancelToken.cancelled = true;
            overlay.remove();
            activeDownloads.delete(tweetId);
            showToast('Download cancelled');
        }, true);

        try {
            const result = await downloadHLS(m3u8Url, (msg, pct) => overlay.update(msg, pct), cancelToken);
            overlay.remove();
            activeDownloads.delete(tweetId);

            const sizeMB = (result.totalSize / (1024 * 1024)).toFixed(1);
            const filename = `twitter_${tweetId}_${result.resolution || 'best'}.mp4`;
            triggerBlobDownload(result.blob, filename);
            const audioNote = result.hasAudio ? ' with audio' : '';
            showToast(`Downloaded ${sizeMB} MB${audioNote} \u2022 ${result.resolution || 'best quality'}`);
        } catch (err) {
            overlay.remove();
            activeDownloads.delete(tweetId);
            if (err.message !== 'Cancelled') {
                console.error('[VidDL] HLS download failed:', err);
                showToast('Download failed: ' + err.message);
            }
        }
    }

    // ==================== UI: PROGRESS OVERLAY ====================

    function createProgressOverlay(player) {
        const overlay = document.createElement('div');
        overlay.className = 'vid-dl-progress';
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
        Object.assign(barOuter.style, {
            width: '80%', maxWidth: '300px', height: '6px',
            background: 'rgba(255,255,255,0.2)', borderRadius: '3px',
            overflow: 'hidden', marginBottom: '14px',
        });
        const barInner = document.createElement('div');
        Object.assign(barInner.style, {
            width: '0%', height: '100%', background: 'rgb(29,155,240)',
            borderRadius: '3px', transition: 'width 0.15s ease',
        });
        barOuter.appendChild(barInner);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        Object.assign(cancelBtn.style, {
            background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)',
            color: 'white', padding: '6px 24px', borderRadius: '18px', cursor: 'pointer',
            fontSize: '13px', fontWeight: '600', transition: 'background 0.15s',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });
        cancelBtn.addEventListener('mouseover', () => { cancelBtn.style.background = 'rgba(255,80,80,0.4)'; });
        cancelBtn.addEventListener('mouseout', () => { cancelBtn.style.background = 'rgba(255,255,255,0.12)'; });

        overlay.appendChild(text);
        overlay.appendChild(barOuter);
        overlay.appendChild(cancelBtn);
        player.appendChild(overlay);

        return {
            update(msg, pct) { text.textContent = msg; barInner.style.width = pct + '%'; },
            remove() { overlay.remove(); },
            cancelBtn,
        };
    }

    // ==================== UI: DOWNLOAD BUTTONS ====================

    const BUTTON_ATTR = 'data-vid-dl-added';

    function addDownloadButtons() {
        document.querySelectorAll('[data-testid="videoPlayer"]').forEach(player => {
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
                position: 'absolute', top: '8px', right: '8px', zIndex: '9999',
                background: 'rgba(0,0,0,0.75)', color: 'white',
                border: '2px solid rgba(255,255,255,0.3)', borderRadius: '20px',
                padding: '6px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: '700',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                display: 'flex', alignItems: 'center', backdropFilter: 'blur(4px)',
                transition: 'all 0.2s ease', opacity: '0', pointerEvents: 'auto',
            });

            player.style.position = 'relative';
            const showBtn = () => { btn.style.opacity = '1'; };
            const hideBtn = () => { if (!player.querySelector('.vid-dl-progress')) btn.style.opacity = '0'; };
            player.addEventListener('mouseenter', showBtn);
            player.addEventListener('mouseleave', hideBtn);
            btn.addEventListener('mouseenter', showBtn);
            btn.addEventListener('mouseover', () => { btn.style.background = 'rgba(29,155,240,0.9)'; btn.style.borderColor = 'rgba(29,155,240,1)'; });
            btn.addEventListener('mouseout', () => { btn.style.background = 'rgba(0,0,0,0.75)'; btn.style.borderColor = 'rgba(255,255,255,0.3)'; });

            btn.addEventListener('click', async (e) => {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

                const tweetId = getTweetIdFromElement(player) || getTweetIdFromUrl(window.location.href);
                let info = findVideoInfo(player);

                console.log('[VidDL] === DOWNLOAD CLICKED ===');
                console.log('[VidDL] Tweet ID:', tweetId);
                console.log('[VidDL] Cached info:', info.m3u8Url ? 'HAS M3U8' : 'no m3u8', '| MP4s:', info.mp4Variants?.length || 0);
                console.log('[VidDL] Total cached videos:', capturedVideos.size, '| Keys:', [...capturedVideos.keys()]);
                console.log('[VidDL] Fetch intercept count so far:', fetchInterceptCount);

                // Active fetch if no M3U8 captured
                if (tweetId && !info.m3u8Url) {
                    console.log('[VidDL] No M3U8 cached, doing active fetch...');
                    const origHTML = btn.innerHTML;
                    btn.innerHTML = '<span style="vertical-align:middle">Fetching...</span>';
                    btn.style.opacity = '1';
                    try {
                        const fetched = await fetchTweetVideoData(tweetId);
                        console.log('[VidDL] Active fetch result:', fetched ? `M3U8=${!!fetched.m3u8Url}, MP4s=${fetched.mp4Variants?.length}` : 'null');
                        if (fetched) info = { tweetId, ...fetched };
                    } catch (err) { console.error('[VidDL] Active fetch exception:', err); }
                    btn.innerHTML = origHTML;
                }

                console.log('[VidDL] Final decision: m3u8Url=', info.m3u8Url || 'none', '| mp4Variants=', info.mp4Variants?.length || 0);

                // Always download best quality
                if (info.m3u8Url) {
                    console.log('[VidDL] Starting HLS download');
                    startHLSDownload(info.m3u8Url, info.tweetId || tweetId || 'video', player);
                } else if (info.mp4Variants?.length > 0) {
                    console.log('[VidDL] Falling back to best MP4:', info.mp4Variants[0].url);
                    const best = info.mp4Variants[0];
                    const resMatch = best.url.match(/\/(\d+x\d+)\//);
                    downloadDirect(best.url, `twitter_${info.tweetId || tweetId || 'video'}_${resMatch?.[1] || 'video'}.mp4`);
                    showToast('Downloading best MP4 (no HLS available)...');
                } else {
                    console.error('[VidDL] FAILED: No video URL found at all');
                    showToast('Could not find video URL. Try playing the video first.');
                }
            }, true);

            player.appendChild(btn);
        });
    }

    // ==================== UI: TOAST ====================

    function showToast(message) {
        const existing = document.getElementById('vid-dl-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'vid-dl-toast';
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(29,155,240,0.95)', color: 'white', padding: '12px 24px',
            borderRadius: '24px', fontSize: '14px', fontWeight: '600', zIndex: '99999',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)', transition: 'opacity 0.3s ease',
            whiteSpace: 'nowrap', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
    }

    // ==================== KEYBOARD SHORTCUT ====================

    document.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            e.preventDefault();
            const videos = document.querySelectorAll('[data-testid="videoPlayer"] video');
            if (videos.length === 0) { showToast('No video found on page'); return; }
            let bestVideo = null, bestScore = -1;
            videos.forEach(v => {
                const rect = v.getBoundingClientRect();
                const visible = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
                if (visible > bestScore) { bestScore = visible; bestVideo = v; }
            });
            if (bestVideo) {
                const player = bestVideo.closest('[data-testid="videoPlayer"]');
                const tweetId = getTweetIdFromElement(bestVideo) || getTweetIdFromUrl(window.location.href);
                let info = findVideoInfo(bestVideo);
                if (tweetId && !info.m3u8Url) {
                    showToast('Fetching best quality...');
                    try { const f = await fetchTweetVideoData(tweetId); if (f) info = { tweetId, ...f }; } catch (e) {}
                }
                if (info.m3u8Url && player) {
                    startHLSDownload(info.m3u8Url, tweetId || 'video', player);
                } else if (info.mp4Variants?.length > 0) {
                    const best = info.mp4Variants[0];
                    const resMatch = best.url.match(/\/(\d+x\d+)\//);
                    downloadDirect(best.url, `twitter_${tweetId || 'video'}_${resMatch?.[1] || 'video'}.mp4`);
                    showToast('Downloading best MP4...');
                } else {
                    showToast('No video URL found. Try playing it first.');
                }
            }
        }
    });

    // ==================== INITIALIZATION ====================

    function init() {
        console.log('[VidDL] Twitter Video Downloader v5.1 loaded');
        addDownloadButtons();
        const observer = new MutationObserver(() => addDownloadButtons());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
