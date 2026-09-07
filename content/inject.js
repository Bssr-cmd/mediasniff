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
        runScrapers();
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

  function runScrapers() {
    if (location.hostname.includes('youtube.com')) {
      getPlayerResponse();
    }
    getVimeoConfig();
  }

  setTimeout(runScrapers, 500);
  setTimeout(runScrapers, 1500);
  setInterval(runScrapers, 5000);
})();
