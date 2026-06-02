/**
 * MediaSniff — Background Service Worker
 * Core detection engine that monitors network requests for media content.
 */
import { HLSParser } from '../lib/hls-parser.js';
import { DASHParser } from '../lib/dash-parser.js';
// ─── Per-Tab Media Registry ─────────────────────────────────────────
const mediaRegistry = new Map(); // tabId -> Map<id, MediaItem>
let idCounter = 0;
// ─── Active Background Downloads Registry ────────────────────────────
const activeDownloads = new Map(); // itemId -> taskState
let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'background/offscreen.html',
    reasons: ['DOM_SCRAPING'],
    justification: 'Media downloading, stream multiplexing, and assembling'
  });

  await offscreenCreating;
  offscreenCreating = null;
}
// ─── Media Detection Patterns ───────────────────────────────────────
const MEDIA_EXTENSIONS = /\.(mp4|webm|mkv|avi|mov|flv|wmv|m4v|3gp|ogv)(\?|#|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|aac|ogg|opus|flac|wav|m4a|wma)(\?|#|$)/i;
const HLS_EXTENSIONS = /\.(m3u8)(\?|#|$)/i;
const DASH_EXTENSIONS = /\.(mpd)(\?|#|$)/i;
const SUBTITLE_EXTENSIONS = /\.(vtt|srt|ass|ssa|sub|ttml)(\?|#|$)/i;
// Streaming segments — these are chunks, NOT standalone files
const SEGMENT_PATTERNS = /\.(ts|m4s|m4f|m4v|m4a|cmfv|cmfa|cmft)(\?|#|$)/i;
const SEGMENT_URL_PATTERNS = [
  /\/seg-\d+/i,          // seg-1, seg-2...
  /\/segment\d+/i,       // segment0, segment1...
  /\/chunk-/i,            // chunk-stream
  /\/frag\(/i,            // frag(123)
  /\/range\/\d+/i,       // range/0, range/1...
  /[?&]sq=\d+/i,         // YouTube sq= sequence
  /[?&]range=/i,          // range= param
  /\.ts\?/i,              // .ts with query params (segment)
];
const MEDIA_MIME_TYPES = [
  'video/', 'audio/',
  'application/x-mpegurl', 'application/vnd.apple.mpegurl',
  'application/dash+xml',
  'application/octet-stream'
];
const YOUTUBE_VIDEO_PATTERN = /\.googlevideo\.com\/videoplayback/i;
const IGNORE_PATTERNS = [
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
  /google\.com\/recaptcha/i,
  /googletagmanager\.com/i,
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
];
const MIN_CONTENT_LENGTH = 50000; // 50KB minimum for direct files
// ─── Request Monitoring ─────────────────────────────────────────────
chrome.webRequest.onCompleted.addListener(
  handleRequest,
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);
async function handleRequest(details) {
  // Skip extension/internal requests
  if (details.tabId < 0) return;
  if (IGNORE_PATTERNS.some(p => p.test(details.url))) return;
  if (details.type === 'image' || details.type === 'stylesheet' || details.type === 'font') return;
  const url = details.url;
  const headers = parseHeaders(details.responseHeaders);
  const contentType = (headers['content-type'] || '').toLowerCase();
  const contentLength = parseInt(headers['content-length']) || 0;
  let mediaType = null;
  let streamType = 'direct';
  let mimeType = contentType.split(';')[0].trim();
  // 0. Check for YouTube/Google Video streams
  if (YOUTUBE_VIDEO_PATTERN.test(url)) {

    try {
      const urlObj = new URL(url);
      const urlParams = urlObj.searchParams;
      const itag = urlParams.get('itag') || '';
      const mime = urlParams.get('mime') || contentType || '';

      if (mime.startsWith('video/') || mime.startsWith('audio/')) {
        // Strip range, sequence, and buffer params to create full-length direct download URLs
        const cleanUrl = url
          .replace(/&range=[^&]+/g, '')
          .replace(/&sq=[^&]+/g, '')
          .replace(/&rn=[^&]+/g, '')
          .replace(/&rbuf=[^&]+/g, '');
        const tabMedia = getTabMedia(details.tabId);
        // Find registered YouTube card on this tab
        const ytItem = Array.from(tabMedia.values()).find(m => m.source === 'youtube');
        if (ytItem) {
          if (!ytItem.directVideoUrls) ytItem.directVideoUrls = {};
          if (!ytItem.directAudioUrls) ytItem.directAudioUrls = {};
          if (mime.startsWith('video/')) {
            const format = ytItem.availableQualities?.find(q => q.itag === parseInt(itag));
            const height = format ? String(format.height) : (urlParams.get('lmt') ? '1080' : 'default');
            ytItem.directVideoUrls[height] = cleanUrl;
            console.log(`[MediaSniff] Associated video stream quality ${height} with YouTube item.`);
          } else if (mime.startsWith('audio/')) {
            ytItem.directAudioUrls['default'] = cleanUrl;
            console.log(`[MediaSniff] Associated default audio stream with YouTube item.`);
          }
          notifyPopup(details.tabId);
        }
      }
    } catch (e) {
      console.warn('[MediaSniff] Error capturing YouTube video stream:', e.message);
    }
    return; // Stop processing so we don't register individual chunks as duplicate cards
  }
  // 1. Check for HLS manifest
  else if (HLS_EXTENSIONS.test(url) || contentType.includes('mpegurl') || contentType.includes('x-mpegurl')) {
    mediaType = 'stream';
    streamType = 'hls';
    mimeType = 'application/x-mpegurl';
  }
  // 2. Check for DASH manifest
  else if (DASH_EXTENSIONS.test(url) || contentType.includes('dash+xml')) {
    mediaType = 'stream';
    streamType = 'dash';
    mimeType = 'application/dash+xml';
  }
  // 3. Check for direct video files
  else if (MEDIA_EXTENSIONS.test(url) || contentType.startsWith('video/')) {
    if (contentLength > MIN_CONTENT_LENGTH || contentType.startsWith('video/')) {
      mediaType = 'video';
    }
  }
  // 4. Check for audio files
  else if (AUDIO_EXTENSIONS.test(url) || contentType.startsWith('audio/')) {
    if (contentLength > MIN_CONTENT_LENGTH || contentType.startsWith('audio/')) {
      mediaType = 'audio';
    }
  }
  // 5. Check for subtitle/caption files
  else if (SUBTITLE_EXTENSIONS.test(url) || contentType.includes('text/vtt') || contentType.includes('application/x-subrip')) {
    mediaType = 'subtitle';
    streamType = 'direct';
    mimeType = contentType || 'text/vtt';
  }
  if (!mediaType) return;
  // ─── Filter out individual streaming segments ─────────────────────
  // These are .ts/.m4s chunks that belong to an HLS/DASH stream — not standalone files
  if (mediaType !== 'subtitle' && streamType === 'direct') {
    if (SEGMENT_PATTERNS.test(url)) return;
    if (SEGMENT_URL_PATTERNS.some(p => p.test(url))) return;
  }
  // ─── Smart deduplication ──────────────────────────────────────────
  const tabMedia = getTabMedia(details.tabId);
  const baseUrl = getBaseUrl(url);
  const isDuplicate = Array.from(tabMedia.values()).some(m => {
    // Exact URL match
    if (m.url === url) return true;
    // Same base URL (ignore query params / CDN cache-busting)
    if (getBaseUrl(m.url) === baseUrl) return true;
    return false;
  });
  if (isDuplicate) return;
  const id = `media_${++idCounter}`;
  const item = {
    id,
    url,
    type: mediaType,
    streamType,
    mimeType,
    contentLength,
    sizeLabel: formatSize(contentLength),
    filename: extractFilename(url, mimeType),
    quality: null,
    variants: [],
    audioRenditions: [],
    subtitles: [],
    isEncrypted: false,
    isLive: false,
    totalDuration: 0,
    segmentCount: 0,
    parsed: false,
    timestamp: Date.now()
  };
  // For subtitle files, extract format info
  if (mediaType === 'subtitle') {
    const ext = url.match(/\.(vtt|srt|ass|ssa|sub|ttml)/i);
    item.quality = ext ? ext[1].toUpperCase() + ' Subtitle' : 'Subtitle';
    item.subtitleFormat = ext ? ext[1].toLowerCase() : 'vtt';
  }
  // Parse streaming manifests
  if (streamType === 'hls' || streamType === 'dash') {
    try {
      const manifestContent = await fetchManifest(url);
      if (streamType === 'hls') {
        await parseHLSManifest(item, manifestContent, url);
      } else {
        parseDASHManifest(item, manifestContent, url);
      }
      item.parsed = true;
    } catch (err) {
      console.warn(`[MediaSniff] Failed to parse ${streamType} manifest:`, err.message);
    }
  }
  tabMedia.set(id, item);
  updateBadge(details.tabId);
  notifyPopup(details.tabId);
}
// ─── HLS Manifest Parsing ───────────────────────────────────────────
async function parseHLSManifest(item, content, url) {
  const parsed = HLSParser.parse(content, url);
  if (parsed.type === 'master') {
    item.variants = parsed.variants.map(v => ({
      url: v.url,
      bandwidth: v.bandwidth,
      resolution: v.resolution,
      width: v.width,
      height: v.height,
      codecs: v.codecs,
      label: v.label
    }));
    item.audioRenditions = parsed.audioRenditions.map(a => ({
      url: a.uri,
      name: a.name,
      language: a.language,
      isDefault: a.isDefault
    }));
    item.quality = item.variants.length > 0 ? item.variants[0].label : null;
  } else {
    // Media playlist
    item.segmentCount = parsed.segmentCount;
    item.totalDuration = parsed.totalDuration;
    item.isLive = parsed.isLive;
    item.isEncrypted = parsed.isEncrypted;
    item.quality = `${parsed.segmentCount} segments · ${formatDuration(parsed.totalDuration)}`;
  }
}
// ─── DASH Manifest Parsing ──────────────────────────────────────────
function parseDASHManifest(item, content, url) {
  const parsed = DASHParser.parse(content, url);
  item.totalDuration = parsed.totalDuration;
  item.isLive = parsed.isLive;
  if (parsed.periods.length > 0) {
    const period = parsed.periods[0];
    // Video variants
    if (period.videoSets.length > 0) {
      for (const vs of period.videoSets) {
        item.isEncrypted = item.isEncrypted || vs.isEncrypted;
        for (const rep of vs.representations) {
          item.variants.push({
            url: rep.baseUrl,
            bandwidth: rep.bandwidth,
            resolution: rep.width && rep.height ? `${rep.width}x${rep.height}` : null,
            width: rep.width,
            height: rep.height,
            codecs: rep.codecs,
            label: rep.label,
            initUrl: rep.initUrl,
            segments: rep.segments,
            segmentCount: rep.segmentCount
          });
        }
      }
    }
    // Audio renditions
    if (period.audioSets.length > 0) {
      for (const as of period.audioSets) {
        for (const rep of as.representations) {
          item.audioRenditions.push({
            url: rep.baseUrl,
            name: `${as.lang || 'default'} (${rep.label})`,
            language: as.lang,
            codecs: rep.codecs,
            bandwidth: rep.bandwidth,
            label: rep.label,
            initUrl: rep.initUrl,
            segments: rep.segments,
            segmentCount: rep.segmentCount
          });
        }
      }
    }
    item.quality = item.variants.length > 0 ? item.variants[0].label : `DASH · ${formatDuration(item.totalDuration)}`;
  }
}
// ─── Content Script Messages ────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_MEDIA') {
    const tabId = message.tabId;
    const tabMedia = getTabMedia(tabId);
    sendResponse({ media: Array.from(tabMedia.values()) });
    return true;
  }
  if (message.type === 'CLEAR_MEDIA') {
    mediaRegistry.delete(message.tabId);
    updateBadge(message.tabId);
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'DOM_MEDIA') {
    if (sender.tab) {
      const tabId = sender.tab.id;
      for (const mediaUrl of message.urls) {
        const tabMedia = getTabMedia(tabId);
        const isDuplicate = Array.from(tabMedia.values()).some(m => m.url === mediaUrl);
        if (!isDuplicate) {
          const id = `media_${++idCounter}`;
          tabMedia.set(id, {
            id, url: mediaUrl, type: 'video', streamType: 'direct',
            mimeType: 'video/unknown', contentLength: 0, sizeLabel: 'Unknown',
            filename: extractFilename(mediaUrl, ''), quality: 'DOM Element',
            variants: [], audioRenditions: [], subtitles: [], isEncrypted: false, isLive: false,
            totalDuration: 0, segmentCount: 0, parsed: false,
            source: 'dom', timestamp: Date.now()
          });
        }
      }
      updateBadge(tabId);
      notifyPopup(tabId);
    }
    return true;
  }
  if (message.type === 'DOM_EMBED') {
    if (sender.tab) {
      const tabId = sender.tab.id;
      for (const embed of message.embeds) {
        const tabMedia = getTabMedia(tabId);

        // Deduplicate: check if this YouTube/Vimeo ID is already registered or URL exists
        const isDuplicate = Array.from(tabMedia.values()).some(m => {
          if (embed.type === 'youtube' && m.source === 'youtube' && m.youtubeId === embed.id) return true;
          if (m.url === embed.url) return true;
          return false;
        });

        if (!isDuplicate) {
          const id = `media_${++idCounter}`;
          if (embed.type === 'youtube') {
            tabMedia.set(id, {
              id,
              url: embed.url,
              type: 'video',
              streamType: 'direct',
              mimeType: 'video/mp4',
              contentLength: 0,
              sizeLabel: 'YouTube',
              filename: embed.title || 'YouTube Video',
              quality: 'Embedded Video',
              variants: [],
              audioRenditions: [],
              subtitles: [],
              isEncrypted: false,
              isLive: false,
              totalDuration: 0,
              segmentCount: 0,
              parsed: true,
              source: 'youtube',
              youtubeId: embed.id,
              thumbnail: `https://img.youtube.com/vi/${embed.id}/hqdefault.jpg`,
              timestamp: Date.now()
            });
          } else {
            tabMedia.set(id, {
              id,
              url: embed.url,
              type: 'video',
              streamType: 'direct',
              mimeType: 'video/unknown',
              contentLength: 0,
              sizeLabel: embed.type.toUpperCase(),
              filename: embed.title || `${embed.type} Video`,
              quality: 'Embedded Video',
              variants: [],
              audioRenditions: [],
              subtitles: [],
              isEncrypted: false,
              isLive: false,
              totalDuration: 0,
              segmentCount: 0,
              parsed: false,
              source: 'dom',
              thumbnail: embed.type === 'vimeo' ? `https://vumbnail.com/${embed.id}.jpg` : null,
              timestamp: Date.now()
            });
          }
        }
      }
      updateBadge(tabId);
      notifyPopup(tabId);
    }
    return true;
  }
  // YouTube player data from content script
  if (message.type === 'YOUTUBE_DATA') {
    if (sender.tab) {
      const tabId = sender.tab.id;
      const tabMedia = getTabMedia(tabId);
      const info = message.videoInfo;
      // Check if we already have this YouTube video (could be placeholder registered by DOM_EMBED)
      const existing = Array.from(tabMedia.values()).find(m => m.source === 'youtube' && m.youtubeId === info.videoId);
      if (existing) {
        // Update placeholder or existing card with latest player data
        const videoFormats = (message.adaptiveFormats || []).filter(f => f.mimeType?.startsWith('video/'));
        const bestVideo = videoFormats.sort((a, b) => b.height - a.height)[0];
        const qualityLabel = bestVideo
          ? `${bestVideo.qualityLabel || bestVideo.height + 'p'} · ${formatBitrate(bestVideo.bitrate)}`
          : 'Unknown';

        existing.quality = qualityLabel;
        existing.filename = info.author ? `${info.author} - ${info.title}` : info.title || existing.filename;
        existing.thumbnail = info.thumbnail || existing.thumbnail;
        if (message.jsUrl) existing.jsUrl = message.jsUrl;
        if (message.adaptiveFormats && message.adaptiveFormats.length > 0) {
          existing.rawAdaptiveFormats = message.adaptiveFormats;
        }
        if (message.formats && message.formats.length > 0) {
          existing.rawFormats = message.formats;
        }
        if (videoFormats.length > 0) {
          existing.availableQualities = videoFormats
            .sort((a, b) => (b.height || 0) - (a.height || 0))
            .map(f => ({
              label: f.qualityLabel || `${f.height}p`,
              height: f.height,
              width: f.width,
              bitrate: f.bitrate,
              itag: f.itag
            }));
        }
        updateBadge(tabId);
        notifyPopup(tabId);
        return true;
      }
      // Build quality info from adaptive formats
      const videoFormats = (message.adaptiveFormats || []).filter(f => f.mimeType?.startsWith('video/'));
      const audioFormats = (message.adaptiveFormats || []).filter(f => f.mimeType?.startsWith('audio/'));
      const watchUrl = `https://www.youtube.com/watch?v=${info.videoId}`;
      // Build quality label for display (best available)
      const bestVideo = videoFormats.sort((a, b) => b.height - a.height)[0];
      const qualityLabel = bestVideo
        ? `${bestVideo.qualityLabel || bestVideo.height + 'p'} · ${formatBitrate(bestVideo.bitrate)}`
        : 'Unknown';
      const id = `media_${++idCounter}`;
      const smartTitle = info.author
        ? `${info.author} - ${info.title}`
        : info.title || 'YouTube Video';
      tabMedia.set(id, {
        id,
        url: watchUrl,
        type: 'video',
        streamType: 'direct',
        mimeType: 'video/mp4',
        contentLength: 0,
        sizeLabel: 'YouTube',
        filename: smartTitle,
        quality: qualityLabel,
        variants: [],  // YouTube downloads go through Cobalt API, not direct variant URLs
        audioRenditions: [],
        subtitles: [],
        isEncrypted: false,
        isLive: info.isLive,
        totalDuration: info.lengthSeconds,
        segmentCount: 0,
        parsed: true,
        source: 'youtube',
        youtubeId: info.videoId,
        thumbnail: info.thumbnail,
        jsUrl: message.jsUrl,
        rawAdaptiveFormats: message.adaptiveFormats || [],
        rawFormats: message.formats || [],
        availableQualities: videoFormats
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .map(f => ({
            label: f.qualityLabel || `${f.height}p`,
            height: f.height,
            width: f.width,
            bitrate: f.bitrate,
            itag: f.itag
          })),
        timestamp: Date.now()
      });
      updateBadge(tabId);
      notifyPopup(tabId);
    }
    return true;
  }
  if (message.type === 'DOWNLOAD_DIRECT') {
    chrome.downloads.download({
      url: message.url,
      filename: sanitizeFilename(message.filename) || undefined,
      saveAs: true
    });
    return true;
  }
  // Handle blob-based downloads with proper filenames
  if (message.type === 'DOWNLOAD_BLOB') {
    // The popup sends us base64 data + filename; we create a proper data URL
    const dataUrl = message.dataUrl;
    const filename = sanitizeFilename(message.filename) || 'download.mp4';
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.warn('[MediaSniff] Download error:', chrome.runtime.lastError.message);
      }
    });
    return true;
  }
  // Get page thumbnail/poster for preview
  if (message.type === 'GET_THUMBNAIL') {
    const tabId = message.tabId;
    try {
      chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_THUMBNAIL' }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ thumbnail: null });
          return;
        }
        sendResponse(response || { thumbnail: null });
      });
    } catch (e) {
      sendResponse({ thumbnail: null });
    }
    return true;
  }
  // Smart naming: get page title for the active tab
  if (message.type === 'GET_PAGE_INFO') {
    const tabId = message.tabId;
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ title: '', url: '' });
        return;
      }
      sendResponse({
        title: tab?.title || '',
        url: tab?.url || ''
      });
    });
    return true;
  }
  // Associate detected subtitles with nearest video
  if (message.type === 'ASSOCIATE_SUBTITLES') {
    const tabMedia = getTabMedia(message.tabId);
    const subs = Array.from(tabMedia.values()).filter(m => m.type === 'subtitle');
    const videos = Array.from(tabMedia.values()).filter(m => m.type === 'stream' || m.type === 'video');
    for (const video of videos) {
      video.subtitles = subs.map(s => ({
        url: s.url,
        filename: s.filename,
        format: s.subtitleFormat || 'vtt',
        language: extractSubLanguage(s.url)
      }));
    }
    sendResponse({ success: true });
    return true;
  }
  // Handle requests from offscreen to trigger downloads (since offscreen cannot call downloads API)
  if (message.type === 'TRIGGER_DOWNLOAD_SAVE') {
    chrome.downloads.download({
      url: message.url,
      filename: sanitizeFilename(message.filename) || undefined,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }
  // Start background download (opens offscreen document and delegates task)
  if (message.type === 'START_DOWNLOAD') {
    const { itemId, item, downloadType, options } = message;
    activeDownloads.set(itemId, {
      itemId,
      status: 'downloading',
      percent: 0,
      statusLabel: 'Preparing...',
      speedLabel: ''
    });
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({
        type: 'START_BACKGROUND_DOWNLOAD',
        itemId, item, downloadType, options
      });
    });
    sendResponse({ success: true });
    return true;
  }
  // Cancel background download
  if (message.type === 'CANCEL_DOWNLOAD') {
    const { itemId } = message;
    chrome.runtime.sendMessage({
      type: 'CANCEL_BACKGROUND_DOWNLOAD',
      itemId
    });
    activeDownloads.delete(itemId);
    sendResponse({ success: true });
    return true;
  }
  // Get list of active background downloads
  if (message.type === 'GET_ACTIVE_DOWNLOADS') {
    sendResponse({ downloads: Array.from(activeDownloads.values()) });
    return true;
  }
  // Process progress updates sent from the offscreen document
  if (message.type === 'BACKGROUND_DOWNLOAD_PROGRESS') {
    const { itemId, status, percent, statusLabel, speedLabel } = message;

    if (status === 'complete' || status === 'failed' || status === 'cancelled') {
      activeDownloads.delete(itemId);
    } else {
      activeDownloads.set(itemId, {
        itemId, status, percent, statusLabel, speedLabel
      });
    }
    // Forward to popup (if popup is open)
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup closed, ignore error
    });
    // Close offscreen document if no more active downloads
    if (activeDownloads.size === 0) {
      setTimeout(async () => {
        if (activeDownloads.size === 0 && await chrome.offscreen.hasDocument()) {
          chrome.offscreen.closeDocument().catch(() => { });
        }
      }, 10000);
    }
    return true;
  }
});
// ─── Tab Navigation & Reinjection ───────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  mediaRegistry.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    // Clear media registry for fresh page loads
    mediaRegistry.delete(tabId);
    updateBadge(tabId);
  }
  if (changeInfo.status === 'complete' && tab?.url) {
    // Page fully loaded — re-inject content script to catch BFCache and SPA navigations
    injectContentScript(tabId);
  }
});
// Re-inject content script when user switches back to a tab
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      injectContentScript(tabId);
      updateBadge(tabId);
    }
  });
});
function injectContentScript(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js']
  }).catch(() => {
    // Tab might be a chrome:// page or extension page — ignore
  });
}
// ─── Helpers ────────────────────────────────────────────────────────
function getTabMedia(tabId) {
  if (!mediaRegistry.has(tabId)) {
    mediaRegistry.set(tabId, new Map());
  }
  return mediaRegistry.get(tabId);
}
function updateBadge(tabId) {
  const tabMedia = mediaRegistry.get(tabId);
  const count = tabMedia ? tabMedia.size : 0;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId });
}
function notifyPopup(tabId) {
  chrome.runtime.sendMessage({ type: 'MEDIA_UPDATED', tabId }).catch(() => { });
}
async function fetchManifest(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}
function parseHeaders(headers) {
  const result = {};
  if (headers) {
    for (const h of headers) {
      result[h.name.toLowerCase()] = h.value;
    }
  }
  return result;
}
function extractFilename(url, mimeType) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/');
    let name = parts[parts.length - 1] || 'media';
    name = decodeURIComponent(name.split('?')[0]);
    if (name.length > 60) name = name.substring(0, 57) + '...';
    return name;
  } catch {
    return 'media';
  }
}
function formatSize(bytes) {
  if (!bytes || bytes === 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / Math.pow(1024, exp)).toFixed(1)} ${units[exp]}`;
}
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function formatBitrate(bps) {
  if (!bps) return '';
  if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`;
  if (bps >= 1000) return `${Math.round(bps / 1000)} Kbps`;
  return `${bps} bps`;
}
function extractSubLanguage(url) {
  // Try to extract language code from subtitle URL
  const langMatch = url.match(/[._-](en|es|fr|de|it|pt|ja|ko|zh|ru|ar|hi|nl|sv|no|da|fi|pl|tr|cs|el|he|th|vi|id|ms|uk|ro|hu|bg|hr|sr|sk|sl|lt|lv|et)[-_.]/i);
  return langMatch ? langMatch[1].toLowerCase() : null;
}
function sanitizeFilename(name) {
  if (!name) return null;
  // Remove path separators and illegal filesystem characters
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '')
    .trim()
    .substring(0, 200);
}
function getBaseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    // Strip query params and hash — just keep scheme + host + path
    return `${u.origin}${u.pathname}`;
  } catch {
    return urlStr;
  }
}