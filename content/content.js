/**
 * MediaSniff — Content Script
 * Scans the DOM for <video> and <audio> elements and monitors dynamic additions.
 * Also extracts YouTube player data and page thumbnails.
 */

(function () {
  'use strict';

  // Guard against duplicate injection — re-scan but don't duplicate observers
  if (window.__mediaSniffInjected) {
    // Already running — trigger a fresh scan by clearing reported URLs
    if (window.__mediaSniffRescan) window.__mediaSniffRescan();
    return;
  }
  window.__mediaSniffInjected = true;

  const reportedUrls = new Set();
  const reportedEmbedIds = new Set();

  const MEDIA_REGEX = /\.(mp4|webm|mkv|avi|mov|flv|wmv|m4v|mp3|aac|ogg|opus|flac|wav|m4a)(\?|#|$)/i;

  function parseEmbedUrl(url) {
    try {
      const u = new URL(url);

      // YouTube Embeds
      if (u.hostname.includes('youtube.com') || u.hostname.includes('youtube-nocookie.com')) {
        const embedMatch = u.pathname.match(/\/embed\/([^/?#]+)/);
        if (embedMatch) {
          return {
            type: 'youtube',
            id: embedMatch[1],
            url: `https://www.youtube.com/watch?v=${embedMatch[1]}`,
            title: 'Embedded YouTube Video'
          };
        }
        const vMatch = u.pathname.match(/\/v\/([^/?#]+)/);
        if (vMatch) {
          return {
            type: 'youtube',
            id: vMatch[1],
            url: `https://www.youtube.com/watch?v=${vMatch[1]}`,
            title: 'Embedded YouTube Video'
          };
        }
      }
      if (u.hostname.includes('youtu.be')) {
        const id = u.pathname.substring(1);
        if (id) {
          return {
            type: 'youtube',
            id: id,
            url: `https://www.youtube.com/watch?v=${id}`,
            title: 'Embedded YouTube Video'
          };
        }
      }

      // Vimeo Embeds
      if (u.hostname.includes('vimeo.com')) {
        const embedMatch = u.pathname.match(/\/video\/([^/?#]+)/);
        if (embedMatch) {
          return {
            type: 'vimeo',
            id: embedMatch[1],
            url: `https://vimeo.com/${embedMatch[1]}`,
            title: 'Embedded Vimeo Video'
          };
        }
      }

      // Dailymotion Embeds
      if (u.hostname.includes('dailymotion.com')) {
        const embedMatch = u.pathname.match(/\/embed\/video\/([^/?#]+)/);
        if (embedMatch) {
          return {
            type: 'dailymotion',
            id: embedMatch[1],
            url: `https://www.dailymotion.com/video/${embedMatch[1]}`,
            title: 'Embedded Dailymotion Video'
          };
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function extractEmbeds() {
    const embeds = [];

    // 1. Scan iframes on the current page for video embed embeds
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      const src = iframe.src || iframe.getAttribute('data-src');
      if (src) {
        const parsed = parseEmbedUrl(src);
        if (parsed) {
          const titleAttr = iframe.getAttribute('title') || iframe.getAttribute('aria-label') || '';
          if (titleAttr && titleAttr.trim()) {
            parsed.title = titleAttr.trim();
          }
          embeds.push(parsed);
        }
      }
    }

    // 2. Scan self location (in case we run inside the embed iframe itself)
    const parsedSelf = parseEmbedUrl(location.href);
    if (parsedSelf) {
      parsedSelf.title = document.title || parsedSelf.title;
      embeds.push(parsedSelf);
    }

    return embeds;
  }

  function extractMediaUrls() {
    const urls = [];

    // Find all video and audio elements
    const mediaElements = document.querySelectorAll('video, audio');
    for (const el of mediaElements) {
      if (el.src && !el.src.startsWith('blob:') && !el.src.startsWith('data:')) {
        urls.push(el.src);
      }
      if (el.currentSrc && !el.currentSrc.startsWith('blob:') && !el.currentSrc.startsWith('data:')) {
        urls.push(el.currentSrc);
      }
      for (const source of el.querySelectorAll('source')) {
        if (source.src && !source.src.startsWith('blob:') && !source.src.startsWith('data:')) {
          urls.push(source.src);
        }
      }
      // Check common data attributes for source URLs (often used by custom players)
      const dataAttrs = ['data-src', 'data-video', 'data-mp4', 'data-stream', 'data-url'];
      for (const attr of dataAttrs) {
        const val = el.getAttribute(attr);
        if (val && !val.startsWith('blob:') && !val.startsWith('data:')) {
          try {
            const resolved = new URL(val, document.baseURI).href;
            if (resolved.startsWith('http')) urls.push(resolved);
          } catch (_) { }
        }
      }
    }

    // Check embed and object elements
    const embedsAndObjects = document.querySelectorAll('embed, object');
    for (const el of embedsAndObjects) {
      const src = el.src || el.getAttribute('data');
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
        try {
          const resolved = new URL(src, document.baseURI).href;
          if (resolved.startsWith('http')) urls.push(resolved);
        } catch (_) { }
      }
    }

    // Check anchor links pointing directly to media files
    const anchors = document.querySelectorAll('a');
    for (const a of anchors) {
      const href = a.href;
      if (href && MEDIA_REGEX.test(href)) {
        urls.push(href);
      }
    }

    // Check iframes for embedded players (same-origin only)
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument;
          if (iframeDoc) {
            const iframeMedia = iframeDoc.querySelectorAll('video, audio');
            for (const el of iframeMedia) {
              if (el.src && !el.src.startsWith('blob:')) urls.push(el.src);
              if (el.currentSrc && !el.currentSrc.startsWith('blob:')) urls.push(el.currentSrc);
            }
          }
        } catch (e) { /* Cross-origin iframe */ }
      }
    } catch (e) { /* ignore */ }

    return [...new Set(urls)];
  }

  function reportMedia() {
    // 1. Report regular direct URLs
    const urls = extractMediaUrls();
    const newUrls = urls.filter(u => !reportedUrls.has(u));

    if (newUrls.length > 0) {
      newUrls.forEach(u => reportedUrls.add(u));
      try {
        chrome.runtime.sendMessage({ type: 'DOM_MEDIA', urls: newUrls });
      } catch (e) { /* Extension context invalidated */ }
    }

    // 2. Report embed platforms (YouTube, Vimeo, Dailymotion)
    const embeds = extractEmbeds();
    const newEmbeds = embeds.filter(emb => !reportedEmbedIds.has(emb.type + '-' + emb.id));

    if (newEmbeds.length > 0) {
      newEmbeds.forEach(emb => reportedEmbedIds.add(emb.type + '-' + emb.id));
      try {
        chrome.runtime.sendMessage({ type: 'DOM_EMBED', embeds: newEmbeds });
      } catch (e) { /* Extension context invalidated */ }
    }
  }

  // ─── YouTube Detection ──────────────────────────────────────────────
  let ytDataReported = false;
  let lastReportedVideoId = null;
  let lastReportedJsUrl = null;
  let lastReportedFormatCount = 0;

  // Listen for the player response from the page context
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'MS_YT_RESPONSE') {
      processYouTubePlayerResponse(event.data.data, event.data.jsUrl);
    }
  });

  function injectPlayerResponseScraper() {
    if (!location.hostname.includes('youtube.com')) return;
    if (ytDataReported) return;
    
    try {
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            const moviePlayer = document.getElementById('movie_player');
            const response = window.ytInitialPlayerResponse 
              || (moviePlayer && typeof moviePlayer.getPlayerResponse === 'function' && moviePlayer.getPlayerResponse());
            if (response && response.streamingData) {
              window.postMessage({ type: 'MS_YT_RESPONSE', data: response }, '*');
            }
          } catch(e) {}
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) { /* ignore */ }
  }

  function processYouTubePlayerResponse(data, mainWorldJsUrl) {
    if (!data) return;
    
    const streamingData = data.streamingData;
    const videoDetails = data.videoDetails;
    if (!streamingData || !videoDetails) return;
    
    const videoId = videoDetails.videoId;
    if (!videoId) return;

    const adaptiveFormats = [];
    if (streamingData.adaptiveFormats) {
      for (const fmt of streamingData.adaptiveFormats) {
        adaptiveFormats.push({
          itag: fmt.itag,
          mimeType: fmt.mimeType || '',
          qualityLabel: fmt.qualityLabel || '',
          bitrate: fmt.bitrate || 0,
          width: fmt.width || 0,
          height: fmt.height || 0,
          contentLength: parseInt(fmt.contentLength) || 0,
          url: fmt.url || '',
          signatureCipher: fmt.signatureCipher || fmt.cipher || '',
        });
      }
    }

    const formats = [];
    if (streamingData.formats) {
      for (const fmt of streamingData.formats) {
        formats.push({
          itag: fmt.itag,
          mimeType: fmt.mimeType || '',
          qualityLabel: fmt.qualityLabel || '',
          bitrate: fmt.bitrate || 0,
          width: fmt.width || 0,
          height: fmt.height || 0,
          contentLength: parseInt(fmt.contentLength) || 0,
          url: fmt.url || '',
          signatureCipher: fmt.signatureCipher || fmt.cipher || '',
        });
      }
    }

    // Extract the player JS URL dynamically from loaded scripts or main world parameter
    const allScripts = Array.from(document.querySelectorAll('script'));
    let jsUrl = mainWorldJsUrl || null;
    if (!jsUrl) {
      for (const s of allScripts) {
        const src = s.src || '';
        if (src.includes('/base.js') || src.includes('/player_ias') || src.includes('/s/player/')) {
          jsUrl = src;
          break;
        }
      }
    }
    if (!jsUrl) {
      for (const s of allScripts) {
        const textContent = s.textContent || '';
        const m = textContent.match(/"jsUrl"\s*:\s*"([^"]+)"/)
          || textContent.match(/"js"\s*:\s*"([^"]+)"/)
          || textContent.match(/ytplayer\.config\s*=\s*[\s\S]+?"js"\s*:\s*"([^"]+)"/)
          || textContent.match(/\/s\/player\/[a-zA-Z0-9_-]+\/player_ias\.vflset\/[a-zA-Z0-9_/-]+\/base\.js/);
        if (m) {
          jsUrl = m[1] || m[0];
          if (jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
          else if (jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;
          break;
        }
      }
    }

    const formatCount = adaptiveFormats.length + formats.length;

    // Check if we already reported this identical video & state to avoid spamming the background registry
    if (lastReportedVideoId === videoId && lastReportedJsUrl === jsUrl && lastReportedFormatCount === formatCount && formatCount > 0) {
      return;
    }

    lastReportedVideoId = videoId;
    lastReportedJsUrl = jsUrl;
    lastReportedFormatCount = formatCount;
    ytDataReported = true;

    const info = {
      title: videoDetails.title || '',
      author: videoDetails.author || '',
      videoId: videoId,
      lengthSeconds: parseInt(videoDetails.lengthSeconds) || 0,
      thumbnail: videoDetails.thumbnail?.thumbnails?.pop()?.url || '',
      isLive: videoDetails.isLiveContent || false,
    };

    try {
      chrome.runtime.sendMessage({
        type: 'YOUTUBE_DATA',
        videoInfo: info,
        adaptiveFormats: adaptiveFormats,
        formats: formats,
        jsUrl: jsUrl,
        hasAdaptiveFormats: adaptiveFormats.length > 0,
      });
    } catch (e) { /* message send failed */ }
  }

  function extractYouTubeData() {
    if (!location.hostname.includes('youtube.com')) return;
    if (ytDataReported) return;

    // 1. Try dynamic main-world injection scraper (highest reliability)
    injectPlayerResponseScraper();

    // 2. Fallback: Parse static script tags (if injection failed or not executed yet)
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (!text) continue;

        const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});/)
          || text.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})(?:;|$)/)
          || text.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});/)
          || text.match(/window\[['"]ytInitialPlayerResponse['"]\]\s*=\s*(\{[\s\S]+?\});/);
        if (!match) continue;

        try {
          const data = JSON.parse(match[1]);
          processYouTubePlayerResponse(data);
        } catch (e) { /* JSON parse failed */ }
        break;
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Thumbnail Extraction ───────────────────────────────────────────
  function extractThumbnail() {
    // 1. og:image meta tag (most sites including YouTube)
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage?.content) return ogImage.content;

    // 2. Twitter card
    const twImage = document.querySelector('meta[name="twitter:image"]');
    if (twImage?.content) return twImage.content;

    // 3. Video poster attribute
    const video = document.querySelector('video[poster]');
    if (video?.poster) return video.poster;

    // 4. Schema.org thumbnailUrl
    const schema = document.querySelector('script[type="application/ld+json"]');
    if (schema) {
      try {
        const json = JSON.parse(schema.textContent);
        if (json.thumbnailUrl) return Array.isArray(json.thumbnailUrl) ? json.thumbnailUrl[0] : json.thumbnailUrl;
        if (json.image?.url) return json.image.url;
      } catch (e) { /* ignore */ }
    }

    return null;
  }

  // ─── Message Listener ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_THUMBNAIL') {
      const thumbnail = extractThumbnail();
      sendResponse({ thumbnail });
      return true;
    }
  });

  // ─── Init ──────────────────────────────────────────────────────────
  function fullRescan() {
    reportedUrls.clear();
    reportedEmbedIds.clear();
    reportMedia();
    if (location.hostname.includes('youtube.com')) {
      ytDataReported = false;
      extractYouTubeData();
    }
  }

  // Expose for re-injection
  window.__mediaSniffRescan = fullRescan;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(reportMedia, 500);
      setTimeout(extractYouTubeData, 1500);
    });
  } else {
    setTimeout(reportMedia, 500);
    setTimeout(extractYouTubeData, 1500);
  }

  // Watch for dynamically added media elements
  const observer = new MutationObserver((mutations) => {
    let hasMedia = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO' ||
            node.tagName === 'SOURCE' || node.querySelector?.('video, audio')) {
            hasMedia = true;
            break;
          }
        }
      }
      if (hasMedia) break;
    }
    if (hasMedia) setTimeout(reportMedia, 300);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Periodic re-scan for SPAs
  setInterval(reportMedia, 5000);

  // Re-check YouTube data on SPA navigation
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ytDataReported = false;
      setTimeout(extractYouTubeData, 2000);
    }
  }, 1000);
})();