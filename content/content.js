/**
 * MediaSniff — Content Script
 * Scans the DOM for <video> and <audio> elements and monitors dynamic additions.
 * Also extracts YouTube player data and page thumbnails.
 */

(function () {
  'use strict';

  const reportedUrls = new Set();

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
    const urls = extractMediaUrls();
    const newUrls = urls.filter(u => !reportedUrls.has(u));

    if (newUrls.length > 0) {
      newUrls.forEach(u => reportedUrls.add(u));
      try {
        chrome.runtime.sendMessage({ type: 'DOM_MEDIA', urls: newUrls });
      } catch (e) { /* Extension context invalidated */ }
    }
  }

  // ─── YouTube Detection ──────────────────────────────────────────────
  let ytDataReported = false;

  function extractYouTubeData() {
    if (!location.hostname.includes('youtube.com')) return;
    if (ytDataReported) return;

    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (!text) continue;

        const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*var\s/);
        if (!match) continue;

        try {
          const data = JSON.parse(match[1]);
          const streamingData = data?.streamingData;
          const videoDetails = data?.videoDetails;

          if (streamingData && videoDetails) {
            ytDataReported = true;

            const info = {
              title: videoDetails.title || '',
              author: videoDetails.author || '',
              videoId: videoDetails.videoId || '',
              lengthSeconds: parseInt(videoDetails.lengthSeconds) || 0,
              thumbnail: videoDetails.thumbnail?.thumbnails?.pop()?.url || '',
              isLive: videoDetails.isLiveContent || false,
            };

            // Collect adaptive formats (separate video/audio streams)
            const formats = [];
            if (streamingData.adaptiveFormats) {
              for (const fmt of streamingData.adaptiveFormats) {
                formats.push({
                  itag: fmt.itag,
                  mimeType: fmt.mimeType || '',
                  qualityLabel: fmt.qualityLabel || '',
                  bitrate: fmt.bitrate || 0,
                  width: fmt.width || 0,
                  height: fmt.height || 0,
                  contentLength: parseInt(fmt.contentLength) || 0,
                  url: fmt.url || null, // null if signature-encrypted
                  hasUrl: !!fmt.url,
                });
              }
            }

            chrome.runtime.sendMessage({
              type: 'YOUTUBE_DATA',
              videoInfo: info,
              formats: formats,
              hasAdaptiveFormats: formats.length > 0,
              hasDashManifest: !!streamingData.dashManifestUrl,
              dashManifestUrl: streamingData.dashManifestUrl || null,
            });
          }
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
