/**
 * MediaSniff — YouTube Main World Inject Script
 * Runs natively inside the MAIN execution world to bypass strict page CSP policies.
 * Directly reads window.ytInitialPlayerResponse and posts it back to the isolated content script.
 * Also hooks XMLHttpRequest to intercept innertube player responses for SPA navigations.
 */
(function () {
  'use strict';

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
        // Retrieve player base.js URL directly from global configuration (ytcfg) or script elements
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

        window.postMessage({ type: 'MS_YT_RESPONSE', data: response, jsUrl: jsUrl }, '*');
      }
    } catch (e) {
      // Ignore context errors
    }
  }

  // Hook fetch to intercept innertube /player responses on SPA navigations
  try {
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const result = originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (url && url.includes('/youtubei/v1/player')) {
          result.then(response => {
            if (response.ok) {
              response.clone().json().then(data => {
                if (data && data.streamingData) {
                  let jsUrl = window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get('PLAYER_JS_URL') : null;
                  if (jsUrl && jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
                  else if (jsUrl && jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;
                  window.postMessage({ type: 'MS_YT_RESPONSE', data: data, jsUrl: jsUrl }, '*');
                }
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return result;
    };
  } catch (e) { /* ignore */ }

  // Periodic polling to catch dynamic player updates and SPA navigations immediately
  setTimeout(getPlayerResponse, 500);
  setTimeout(getPlayerResponse, 1500);
  setInterval(getPlayerResponse, 3000);
})();
