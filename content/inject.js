/**
 * MediaSniff — Universal Main World Inject Script
 * Runs natively inside the MAIN execution world across all pages and iframes.
 * Bypasses strict page CSP policies and hooks fetch, XMLHttpRequest, Hls.js,
 * and HTMLMediaElement to intercept HLS (.m3u8), DASH (.mpd), and player configurations.
 */
(function () {
  'use strict';

  // Guard against multiple executions in same frame
  if (window.__mediaSniffInjectLoaded) return;
  window.__mediaSniffInjectLoaded = true;

  // ─── Universal Manifest Reporter ────────────────────────────────────
  const reportedManifests = new Map(); // url -> boolean (hasContent)

  function reportManifest(url, content, manifestType) {
    if (!url || typeof url !== 'string') return;
    try {
      url = new URL(url, document.baseURI).href;
    } catch (_) {}

    const alreadyHasContent = reportedManifests.get(url);
    if (alreadyHasContent && !content) return;
    if (content) {
      reportedManifests.set(url, true);
    } else if (!reportedManifests.has(url)) {
      reportedManifests.set(url, false);
    } else {
      return;
    }

    window.postMessage({
      type: 'MS_MANIFEST_DETECTED',
      url,
      content: content || null,
      manifestType: manifestType || 'hls'
    }, '*');
  }

  // ─── Performance API Resource Timing Sniffer ─────────────────────────
  function scanPerformanceEntries() {
    try {
      if (typeof performance === 'undefined' || !performance.getEntriesByType) return;
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        const name = entry.name;
        if (!name || typeof name !== 'string') continue;
        const nameLower = name.toLowerCase();
        if (nameLower.includes('.m3u8')) {
          reportManifest(name, null, 'hls');
        } else if (nameLower.includes('.mpd')) {
          reportManifest(name, null, 'dash');
        } else if (nameLower.includes('master.json') || (name.includes('vimeocdn.com') && name.includes('master.json'))) {
          reportManifest(name, null, 'hls');
        }
      }
    } catch (_) {}
  }

  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const po = new PerformanceObserver((list) => {
        try {
          for (const entry of list.getEntries()) {
            const name = entry.name;
            if (!name || typeof name !== 'string') continue;
            const nameLower = name.toLowerCase();
            if (nameLower.includes('.m3u8')) {
              reportManifest(name, null, 'hls');
            } else if (nameLower.includes('.mpd')) {
              reportManifest(name, null, 'dash');
            } else if (nameLower.includes('master.json') || (name.includes('vimeocdn.com') && name.includes('master.json'))) {
              reportManifest(name, null, 'hls');
            }
          }
        } catch (_) {}
      });
      po.observe({ entryTypes: ['resource'] });
    }
  } catch (_) {}

  // ─── YouTube Detection ──────────────────────────────────────────────
  function getPlayerResponse() {
    try {
      const moviePlayer = document.getElementById('movie_player');
      let response = null;
      if (moviePlayer && typeof moviePlayer.getPlayerResponse === 'function') {
        response = moviePlayer.getPlayerResponse();
      }
      if (!response) {
        response = window.ytInitialPlayerResponse;
      }

      if (response && response.streamingData) {
        let jsUrl = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get('PLAYER_JS_URL') : null;
        if (!jsUrl) {
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const src = s.src || '';
            if (src.includes('/base.js') || src.includes('/player_ias') || src.includes('/s/player/')) {
              jsUrl = src;
              break;
            }
          }
        }
        if (jsUrl && jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
        else if (jsUrl && jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;

        const videoId = response.videoDetails?.videoId;
        if (videoId && window._lastSentYtVideoId === videoId) return;
        window._lastSentYtVideoId = videoId;

        window.postMessage({ type: 'MS_YT_RESPONSE', data: response, jsUrl }, '*');
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Vimeo Detection ────────────────────────────────────────────────
  function getVimeoConfig() {
    try {
      const config = window.playerConfig || (window.__vimeo && window.__vimeo.config) || (window.vimeo && window.vimeo.config);
      if (config && (config.request?.files || config.files || config.video)) {
        const vimeoId = config.video?.id;
        if (vimeoId && window._lastSentVimeoId === vimeoId) return;
        window._lastSentVimeoId = vimeoId;
        window.postMessage({ type: 'MS_VIMEO_RESPONSE', data: config }, '*');
        return;
      }
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent || '';
        if (text.includes('playerConfig') || (text.includes('"files"') && text.includes('"hls"'))) {
          const m = text.match(/window\.playerConfig\s*=\s*(\{[\s\S]+?\});\s*(?:var\s|window|<|\n)/)
            || text.match(/var\s+config\s*=\s*(\{[\s\S]+?\});/)
            || text.match(/vimeo\.config\s*=\s*(\{[\s\S]+?\});/);
          if (m) {
            try {
              const parsed = JSON.parse(m[1]);
              if (parsed && (parsed.request?.files || parsed.files || parsed.video)) {
                const parsedVimeoId = parsed.video?.id;
                if (parsedVimeoId && window._lastSentVimeoId === parsedVimeoId) return;
                window._lastSentVimeoId = parsedVimeoId;
                window.postMessage({ type: 'MS_VIMEO_RESPONSE', data: parsed }, '*');
                return;
              }
            } catch (_) {}
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Instagram Detection ────────────────────────────────────────────
  const reportedIgMediaIds = new Set();

  function findInstagramMediaNodes(root, results = [], seenIds = new Set()) {
    if (!root || typeof root !== 'object') return results;

    const hasVideoVersions = Array.isArray(root.video_versions) && root.video_versions.length > 0;
    const hasDashManifest = typeof root.video_dash_manifest === 'string' && root.video_dash_manifest.includes('<MPD');
    const hasVideoUrl = typeof root.video_url === 'string' && (root.is_video === true || root.__typename === 'GraphVideo');

    if (hasVideoVersions || hasDashManifest || hasVideoUrl) {
      const id = root.code || root.shortcode || root.id || root.pk || (hasVideoVersions ? root.video_versions[0].url : root.video_url);
      const strId = String(id || '');
      if (!strId || !seenIds.has(strId)) {
        if (strId) seenIds.add(strId);
        results.push(root);
      }
    }

    if (Array.isArray(root)) {
      for (const item of root) {
        findInstagramMediaNodes(item, results, seenIds);
      }
    } else {
      for (const key of Object.keys(root)) {
        if (typeof root[key] === 'object' && root[key] !== null) {
          findInstagramMediaNodes(root[key], results, seenIds);
        }
      }
    }
    return results;
  }

  function parseInstagramDash(dashXml) {
    const dashVariants = [];
    const dashAudio = [];
    if (!dashXml || typeof dashXml !== 'string') return { dashVariants, dashAudio };

    // 1. Try DOMParser if available
    if (typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(dashXml, 'application/xml');
        const adaptSets = Array.from(doc.querySelectorAll('AdaptationSet'));
        for (const as of adaptSets) {
          const mime = as.getAttribute('mimeType') || '';
          const contentType = as.getAttribute('contentType') || (mime.includes('video') ? 'video' : mime.includes('audio') ? 'audio' : '');
          const isVideo = contentType === 'video' || mime.includes('video');
          const isAudio = contentType === 'audio' || mime.includes('audio');

          const reps = Array.from(as.querySelectorAll('Representation'));
          for (const rep of reps) {
            const width = parseInt(rep.getAttribute('width')) || 0;
            const height = parseInt(rep.getAttribute('height')) || 0;
            const bandwidth = parseInt(rep.getAttribute('bandwidth')) || 0;
            const codecs = rep.getAttribute('codecs') || '';
            const baseUrlEl = rep.querySelector('BaseURL');
            let rawUrl = baseUrlEl ? baseUrlEl.textContent.trim() : '';
            if (!rawUrl) continue;
            const cleanUrl = rawUrl
              .replace(/([?&])(?:bytestart|byteend)=[^&#]*/g, (m, p) => p === '?' ? '?' : '')
              .replace(/\?&/, '?').replace(/\?(?=#|$)/, '');

            if (isVideo) {
              dashVariants.push({
                url: cleanUrl,
                width,
                height,
                bandwidth,
                codecs,
                label: height ? `${height}p` : 'DASH Video',
                isDash: true
              });
            } else if (isAudio) {
              dashAudio.push({
                url: cleanUrl,
                bandwidth,
                codecs,
                label: 'Default Audio',
                isDash: true
              });
            }
          }
        }
        if (dashVariants.length > 0 || dashAudio.length > 0) {
          return { dashVariants, dashAudio };
        }
      } catch (_) {}
    }

    // 2. Regex fallback parser
    try {
      const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
      let match;
      while ((match = repRegex.exec(dashXml)) !== null) {
        const attrs = match[1];
        const body = match[2];

        const mimeMatch = attrs.match(/mimeType="([^"]+)"/i);
        const mime = mimeMatch ? mimeMatch[1] : '';
        const widthMatch = attrs.match(/width="(\d+)"/i);
        const width = widthMatch ? parseInt(widthMatch[1]) : 0;
        const heightMatch = attrs.match(/height="(\d+)"/i);
        const height = heightMatch ? parseInt(heightMatch[1]) : 0;
        const bwMatch = attrs.match(/bandwidth="(\d+)"/i);
        const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
        const codecsMatch = attrs.match(/codecs="([^"]+)"/i);
        const codecs = codecsMatch ? codecsMatch[1] : '';

        const baseMatch = body.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
        if (!baseMatch) continue;
        let cleanUrl = baseMatch[1].trim()
          .replace(/&amp;/g, '&')
          .replace(/([?&])(?:bytestart|byteend)=[^&#]*/g, (m, p) => p === '?' ? '?' : '')
          .replace(/\?&/, '?').replace(/\?(?=#|$)/, '');

        if (mime.includes('video') || width > 0 || height > 0) {
          dashVariants.push({
            url: cleanUrl,
            width,
            height,
            bandwidth,
            codecs,
            label: height ? `${height}p` : 'DASH Video',
            isDash: true
          });
        } else if (mime.includes('audio')) {
          dashAudio.push({
            url: cleanUrl,
            bandwidth,
            codecs,
            label: 'Default Audio',
            isDash: true
          });
        }
      }
    } catch (_) {}

    return { dashVariants, dashAudio };
  }

  function formatInstagramItem(node) {
    const shortcode = node.code || node.shortcode || (node.pk ? String(node.pk) : null);
    const user = node.user || node.owner || {};
    const username = user.username || '';
    const fullName = user.full_name || '';
    const caption = node.caption?.text || node.edge_media_to_caption?.edges?.[0]?.node?.text || node.title || '';
    const duration = node.video_duration || 0;

    const thumbCandidates = node.image_versions2?.candidates || [];
    const thumbnail = thumbCandidates[0]?.url || node.display_url || node.thumbnail_src || user.profile_pic_url || null;

    let videoVersions = [];
    if (Array.isArray(node.video_versions)) {
      videoVersions = node.video_versions.map(v => ({
        url: v.url,
        width: v.width || 0,
        height: v.height || 0,
        label: v.height ? `${v.height}p` : 'HD Video',
        isDirect: true
      })).filter(v => v.url);
    } else if (node.video_url) {
      videoVersions = [{
        url: node.video_url,
        width: node.dimensions?.width || 0,
        height: node.dimensions?.height || 0,
        label: node.dimensions?.height ? `${node.dimensions.height}p` : 'HD Video',
        isDirect: true
      }];
    }

    // Sort descending by resolution (area, then height) so index 0 is always highest quality
    videoVersions.sort((a, b) => {
      const areaA = (a.width || 0) * (a.height || 0);
      const areaB = (b.width || 0) * (b.height || 0);
      if (areaB !== areaA) return areaB - areaA;
      return (b.height || 0) - (a.height || 0);
    });

    const dashManifest = node.video_dash_manifest || null;
    const { dashVariants, dashAudio } = parseInstagramDash(dashManifest);
    const pageUrl = shortcode ? `https://www.instagram.com/reel/${shortcode}/` : location.href;

    return {
      id: shortcode || String(Date.now()),
      shortcode,
      username,
      fullName,
      caption,
      duration,
      thumbnail,
      videoVersions,
      dashVariants,
      dashAudio,
      dashManifest,
      pageUrl
    };
  }

  const reportedIgMedia = new Map(); // key -> { height, formatCount }

  function reportInstagramMedia(items) {
    if (!items || items.length === 0) return;
    const newItems = items.filter(it => {
      const key = it.shortcode || it.id || it.videoVersions?.[0]?.url;
      if (!key) return false;
      const bestH = it.videoVersions?.[0]?.height || 0;
      const fmtCount = it.videoVersions?.length || 0;
      const prev = reportedIgMedia.get(key);
      if (prev && prev.height >= bestH && prev.formatCount >= fmtCount) {
        return false;
      }
      reportedIgMedia.set(key, { height: bestH, formatCount: fmtCount });
      return true;
    });
    if (newItems.length > 0) {
      window.postMessage({ type: 'MS_INSTAGRAM_RESPONSE', data: newItems }, '*');
    }
  }

  function extractBalancedJson(text, startIndex, openChar = '{', closeChar = '}') {
    let depth = 0;
    let inString = false;
    let escape = false;
    let start = -1;
    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === openChar) {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === closeChar) {
          depth--;
          if (depth === 0 && start !== -1) {
            return text.slice(start, i + 1);
          }
        }
      }
    }
    return null;
  }

  function scanInstagramScripts() {
    if (!location.hostname.includes('instagram.com')) return;
    try {
      if (window.__additionalData) {
        for (const k of Object.keys(window.__additionalData)) {
          const nodes = findInstagramMediaNodes(window.__additionalData[k]);
          if (nodes.length > 0) reportInstagramMedia(nodes.map(formatInstagramItem));
        }
      }
      if (window._sharedData) {
        const nodes = findInstagramMediaNodes(window._sharedData);
        if (nodes.length > 0) reportInstagramMedia(nodes.map(formatInstagramItem));
      }

      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent;
        if (!text || text.length > 3000000) continue;
        if (text.includes('video_versions') || text.includes('video_dash_manifest') || text.includes('"GraphVideo"')) {
          // 1. Try direct JSON.parse if script is pure JSON
          try {
            const data = JSON.parse(text);
            const nodes = findInstagramMediaNodes(data);
            if (nodes.length > 0) {
              reportInstagramMedia(nodes.map(formatInstagramItem));
              continue;
            }
          } catch (_) {}

          // 2. Extract balanced JSON objects (e.g. xdt_shortcode_media, xdt_api__v1__media, items)
          const objMarkers = ['"xdt_shortcode_media"', '"xdt_api__v1__media__shortcode__web_info"', '"items"'];
          for (const marker of objMarkers) {
            let idx = text.indexOf(marker);
            while (idx !== -1) {
              const openBrace = text.indexOf('{', idx + marker.length);
              if (openBrace !== -1 && openBrace - idx < 50) {
                const jsonStr = extractBalancedJson(text, openBrace, '{', '}');
                if (jsonStr) {
                  try {
                    const parsed = JSON.parse(jsonStr);
                    const nodes = findInstagramMediaNodes(parsed);
                    if (nodes.length > 0) {
                      reportInstagramMedia(nodes.map(formatInstagramItem));
                    }
                  } catch (_) {}
                }
              }
              idx = text.indexOf(marker, idx + marker.length);
            }
          }

          // 3. Fallback: Extract isolated video_versions array directly from JS text
          let vvIdx = text.indexOf('"video_versions"');
          while (vvIdx !== -1) {
            const openBracket = text.indexOf('[', vvIdx + 16);
            if (openBracket !== -1 && openBracket - vvIdx < 30) {
              const arrayStr = extractBalancedJson(text, openBracket, '[', ']');
              if (arrayStr) {
                try {
                  const versions = JSON.parse(arrayStr);
                  if (Array.isArray(versions) && versions.length > 0 && versions[0].url) {
                    const scMatch = location.pathname.match(/\/(?:reel|reels|p)\/([a-zA-Z0-9_-]+)/);
                    const shortcode = scMatch ? scMatch[1] : null;
                    const pseudoNode = {
                      shortcode,
                      code: shortcode,
                      video_versions: versions,
                      caption: { text: document.title || '' },
                      user: {}
                    };
                    reportInstagramMedia([formatInstagramItem(pseudoNode)]);
                  }
                } catch (_) {}
              }
            }
            vvIdx = text.indexOf('"video_versions"', vvIdx + 16);
          }
        }
      }
    } catch (_) {}
  }

  // ─── Hook window.fetch ──────────────────────────────────────────────
  try {
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] instanceof URL ? args[0].href : args[0]?.url);
      if (url && typeof url === 'string') {
        const urlLower = url.toLowerCase();
        // Immediately report HLS/DASH requests without waiting for network completion
        if (urlLower.includes('.m3u8')) {
          reportManifest(url, null, 'hls');
        } else if (urlLower.includes('.mpd')) {
          reportManifest(url, null, 'dash');
        } else if (urlLower.includes('master.json') || (url.includes('vimeocdn.com') && url.includes('master.json'))) {
          reportManifest(url, null, 'hls');
        }
      }

      const result = originalFetch.apply(this, args);
      try {
        if (!url || typeof url !== 'string') return result;

        const urlLower = url.toLowerCase();

        // 1. YouTube player data
        if (url.includes('/youtubei/v1/player')) {
          result.then(response => {
            if (response.ok) {
              response.clone().json().then(data => {
                if (data && data.streamingData) {
                  let jsUrl = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get('PLAYER_JS_URL') : null;
                  if (jsUrl && jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
                  else if (jsUrl && jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;
                  window.postMessage({ type: 'MS_YT_RESPONSE', data, jsUrl }, '*');
                }
              }).catch(() => {});
            }
          }).catch(() => {});
          return result;
        }

        // 2. Vimeo player config
        if ((url.includes('player.vimeo.com/video/') || url.includes('/config')) && !url.includes('.js')) {
          result.then(response => {
            if (response.ok) {
              response.clone().json().then(data => {
                if (data && (data.request?.files || data.files || data.video)) {
                  window.postMessage({ type: 'MS_VIMEO_RESPONSE', data }, '*');
                }
              }).catch(() => {});
            }
          }).catch(() => {});
        }

        // 2b. Instagram GraphQL & API responses
        if ((location.hostname.includes('instagram.com') || url.includes('/graphql/query') || url.includes('/api/v1/')) && !url.includes('.js') && !url.includes('.css')) {
          result.then(response => {
            if (response.ok) {
              response.clone().text().then(text => {
                if (text && (text.includes('video_versions') || text.includes('video_dash_manifest') || text.includes('"GraphVideo"'))) {
                  try {
                    const data = JSON.parse(text);
                    const nodes = findInstagramMediaNodes(data);
                    if (nodes.length > 0) {
                      reportInstagramMedia(nodes.map(formatInstagramItem));
                    }
                  } catch (_) {}
                }
              }).catch(() => {});
            }
          }).catch(() => {});
        }

        // 3. Inspect response text for HLS / DASH manifests
        if (!/\.(ts|m4s|m4f|m4v|m4a|cmfv|cmfa|js|css|png|jpg|jpeg|gif|webp|woff|woff2|svg|ico)(\?|#|$)/i.test(url)) {
          result.then(response => {
            if (!response.ok) return;
            const ct = (response.headers.get('content-type') || '').toLowerCase();
            const cl = parseInt(response.headers.get('content-length') || '0');
            if (cl > 0 && cl > 2 * 1024 * 1024) { /* skip, too large */ }
            else if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || urlLower.includes('.m3u8') || urlLower.includes('master.json')) {
              response.clone().text().then(content => {
                reportManifest(url, content, 'hls');
              }).catch(() => {});
            } else if (ct.includes('dash+xml') || urlLower.includes('.mpd')) {
              response.clone().text().then(content => {
                reportManifest(url, content.includes('<MPD') ? content : content, 'dash');
              }).catch(() => {});
            } else if (ct.includes('text') || ct.includes('octet-stream') || ct === '') {
              response.clone().text().then(content => {
                if (content && content.startsWith('#EXTM3U')) {
                  reportManifest(url, content, 'hls');
                } else if (content && content.includes('<MPD') && content.includes('</MPD>')) {
                  reportManifest(url, content, 'dash');
                }
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return result;
    };
  } catch (e) { /* ignore */ }

  // ─── Hook XMLHttpRequest ────────────────────────────────────────────
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._msUrl = typeof url === 'string' ? url : String(url);
      if (this._msUrl) {
        const uLower = this._msUrl.toLowerCase();
        if (uLower.includes('.m3u8')) {
          reportManifest(this._msUrl, null, 'hls');
        } else if (uLower.includes('.mpd')) {
          reportManifest(this._msUrl, null, 'dash');
        } else if (uLower.includes('master.json') || (this._msUrl.includes('vimeocdn.com') && this._msUrl.includes('master.json'))) {
          reportManifest(this._msUrl, null, 'hls');
        }
      }
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        try {
          const url = this._msUrl;
          if (!url) return;
          const urlLower = url.toLowerCase();

          // Safely read response text without throwing InvalidStateError on arraybuffer/blob
          let responseText = null;
          try {
            if (!this.responseType || this.responseType === 'text') {
              responseText = this.responseText;
            } else if (this.responseType === 'arraybuffer' && this.response) {
              const urlLower = this._msUrl?.toLowerCase() || '';
              if (urlLower.includes('.m3u8') || urlLower.includes('.mpd') || urlLower.includes('master.json') || urlLower.includes('player.vimeo.com') || urlLower.includes('/manifest')) {
                responseText = new TextDecoder('utf-8').decode(new Uint8Array(this.response, 0, Math.min(this.response.byteLength, 65536)));
              }
            }
          } catch (_) {}

          // Vimeo config
          if ((url.includes('player.vimeo.com/video/') || url.includes('/config')) && !url.includes('.js') && responseText) {
            try {
              const data = JSON.parse(responseText);
              if (data && (data.request?.files || data.files || data.video)) {
                window.postMessage({ type: 'MS_VIMEO_RESPONSE', data }, '*');
              }
            } catch (_) {}
          }

          // Instagram GraphQL / API responses
          if ((location.hostname.includes('instagram.com') || url.includes('/graphql/query') || url.includes('/api/v1/')) && responseText) {
            if (responseText.includes('video_versions') || responseText.includes('video_dash_manifest') || responseText.includes('"GraphVideo"')) {
              try {
                const data = JSON.parse(responseText);
                const nodes = findInstagramMediaNodes(data);
                if (nodes.length > 0) {
                  reportInstagramMedia(nodes.map(formatInstagramItem));
                }
              } catch (_) {}
            }
          }

          // Vimeo / general master.json
          if (urlLower.includes('master.json') || (url.includes('vimeocdn.com') && url.includes('master.json'))) {
            reportManifest(url, responseText, 'hls');
          }

          // HLS .m3u8
          if (urlLower.includes('.m3u8') || (responseText && responseText.startsWith('#EXTM3U'))) {
            const content = (responseText && responseText.startsWith('#EXTM3U')) ? responseText : null;
            reportManifest(url, content, 'hls');
          } else if (urlLower.includes('.mpd') || (responseText && responseText.includes('<MPD'))) {
            reportManifest(url, responseText, 'dash');
          }
        } catch (_) {}
      });
      return origSend.apply(this, args);
    };
  } catch (_) {}

  // ─── Hook Hls.js (window.Hls) ───────────────────────────────────────
  function hookHls(hlsClass) {
    if (!hlsClass || !hlsClass.prototype || hlsClass.prototype._msHooked) return;
    hlsClass.prototype._msHooked = true;
    const origLoad = hlsClass.prototype.loadSource;
    hlsClass.prototype.loadSource = function (url) {
      if (url && typeof url === 'string') {
        reportManifest(url, null, 'hls');
      }
      return origLoad.apply(this, arguments);
    };

    const origOn = hlsClass.prototype.on;
    if (origOn) {
      hlsClass.prototype.on = function (event, handler) {
        if (event === 'hlsManifestLoaded' || event === 'hlsManifestParsed') {
          const wrapped = function (ev, data) {
            try {
              const manifestUrl = data?.networkDetails?.url || data?.url || this.url;
              const content = data?.content || null;
              if (manifestUrl) {
                reportManifest(manifestUrl, content, 'hls');
              }
            } catch (_) {}
            return handler.apply(this, arguments);
          };
          return origOn.call(this, event, wrapped);
        }
        return origOn.apply(this, arguments);
      };
    }
  }

  if (window.Hls) hookHls(window.Hls);
  let currentHls = window.Hls;
  try {
    Object.defineProperty(window, 'Hls', {
      configurable: true,
      enumerable: true,
      get() { return currentHls; },
      set(v) {
        currentHls = v;
        hookHls(v);
      }
    });
  } catch (_) {}

  // ─── Hook MediaSource & URL.createObjectURL ─────────────────────────
  try {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const res = origCreateObjectURL.apply(this, arguments);
      if (obj && (typeof MediaSource !== 'undefined' && obj instanceof MediaSource)) {
        setTimeout(scanPerformanceEntries, 200);
        setTimeout(scanPerformanceEntries, 1000);
        setTimeout(scanPerformanceEntries, 2500);
      }
      return res;
    };
  } catch (_) {}

  // ─── Hook HTMLMediaElement.src ──────────────────────────────────────
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set && !desc.set._msHooked) {
      const origSet = desc.set;
      const hookedSet = function (val) {
        if (val && typeof val === 'string') {
          const vLower = val.toLowerCase();
          if (vLower.includes('.m3u8')) {
            reportManifest(val, null, 'hls');
          } else if (vLower.includes('.mpd')) {
            reportManifest(val, null, 'dash');
          }
        }
        return origSet.call(this, val);
      };
      hookedSet._msHooked = true;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...desc, set: hookedSet });
    }
  } catch (_) {}

  const fetchedIgShortcodes = new Set();
  async function fetchInstagramReelData(shortcode) {
    if (!shortcode || fetchedIgShortcodes.has(shortcode)) return;
    fetchedIgShortcodes.add(shortcode);
    try {
      const queryUrl = `https://www.instagram.com/graphql/query/?doc_id=8845758582119845&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
      const resp = await fetch(queryUrl, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (resp.ok) {
        const json = await resp.json();
        const nodes = findInstagramMediaNodes(json);
        if (nodes.length > 0) {
          reportInstagramMedia(nodes.map(formatInstagramItem));
          return;
        }
      }
    } catch (_) {}

    try {
      const fallbackUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
      const resp2 = await fetch(fallbackUrl, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (resp2.ok) {
        const json2 = await resp2.json();
        const nodes2 = findInstagramMediaNodes(json2);
        if (nodes2.length > 0) {
          reportInstagramMedia(nodes2.map(formatInstagramItem));
        }
      }
    } catch (_) {}
  }

  // ─── Page Messages & Scrapers ───────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event && event.data) {
      if (event.data.type === 'MS_REQUEST_YT_DATA') {
        getPlayerResponse();
      }
      if (event.data.type === 'MS_REQUEST_VIMEO_DATA') {
        getVimeoConfig();
      }
      if (event.data.type === 'MS_TRIGGER_INJECT_SCAN') {
        runScrapers(event.data.shortcode);
      }
    }
  });

  function scanScriptsForManifests() {
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent || '';
        if (!text || text.length > 500000) continue;
        const m3u8Matches = text.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi);
        for (const m of m3u8Matches) {
          reportManifest(m[0], null, 'hls');
        }
        const mpdMatches = text.matchAll(/https?:\/\/[^\s"'<>]+\.mpd[^\s"'<>]*/gi);
        for (const m of mpdMatches) {
          reportManifest(m[0], null, 'dash');
        }
      }
    } catch (_) {}
  }

  function runScrapers(shortcodeHint) {
    if (location.hostname.includes('youtube.com')) {
      getPlayerResponse();
    }
    getVimeoConfig();
    if (location.hostname.includes('instagram.com')) {
      scanInstagramScripts();
      const sc = shortcodeHint || location.pathname.match(/\/(?:reel|reels|p)\/([a-zA-Z0-9_-]+)/)?.[1];
      if (sc) {
        fetchInstagramReelData(sc);
      }
    }
  }

  setTimeout(runScrapers, 500);
  setTimeout(runScrapers, 1500);
  setInterval(runScrapers, 5000);
})();
