/**
 * MediaSniff — Background Service Worker
 * Core detection engine that monitors network requests for media content.
 */
import { HLSParser } from '../lib/hls-parser.js';
import { DASHParser } from '../lib/dash-parser.js';
// ─── Per-Tab Media Registry & Storage Sync ───────────────────────────
const mediaRegistry = new Map(); // tabId -> Map<id, MediaItem>
let idCounter = 0;

// Eagerly restore all tabs from storage on service worker spin-up
const storageInitPromise = (async () => {
  try {
    const storage = chrome.storage?.session || chrome.storage?.local;
    if (storage) {
      const all = await storage.get(null);
      for (const [key, val] of Object.entries(all)) {
        if (key.startsWith('tab_media_') && Array.isArray(val) && val.length > 0) {
          const tabId = parseInt(key.replace('tab_media_', ''));
          if (!isNaN(tabId)) {
            const map = new Map();
            for (const item of val) {
              map.set(item.id, item);
            }
            mediaRegistry.set(tabId, map);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[MediaSniff] Failed to initialize media registry from storage:', e);
  }
})();
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
chrome.webRequest.onResponseStarted.addListener(
  handleRequest,
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);
const inFlightRequests = new Set();
async function handleRequest(details) {
  // Skip extension/internal requests
  if (details.tabId < 0) return;
  if (IGNORE_PATTERNS.some(p => p.test(details.url))) return;
  if (details.type === 'image' || details.type === 'stylesheet' || details.type === 'font') return;

  const reqKey = `${details.tabId}_${getBaseUrl(details.url)}`;
  if (inFlightRequests.has(reqKey)) return;
  inFlightRequests.add(reqKey);
  setTimeout(() => inFlightRequests.delete(reqKey), 4000);

  let url = details.url;
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
          .replace(/([?&])(?:range|sq|rn|rbuf)=[^&#]*/g, (m, p) => p === '?' ? '?' : '')
          .replace(/\?&/, '?')
          .replace(/\?(?=#|$)/, '');
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
  // 0b. Check for Vimeo player config
  else if (url.includes('player.vimeo.com/video/') && url.includes('/config')) {
    try {
      const resp = await fetch(url, { credentials: 'include', headers: { Referer: details.initiator || url } });
      if (resp.ok) {
        const config = await resp.json();
        await processVimeoConfig(config, details.tabId, details.initiator || url);
      }
    } catch (e) {
      console.warn('[MediaSniff] Error processing Vimeo config request:', e.message);
    }
    return;
  }
  // 1. Check for HLS manifest
  else if (
    HLS_EXTENSIONS.test(url) ||
    url.toLowerCase().includes('.m3u8') ||
    url.toLowerCase().includes('master.json') ||
    contentType.includes('mpegurl') ||
    contentType.includes('x-mpegurl')
  ) {
    mediaType = 'stream';
    streamType = 'hls';
    mimeType = url.includes('master.json') ? 'application/json' : 'application/x-mpegurl';
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
  // ─── Detect or attach individual streaming segments ───────────────
  const isSegment = SEGMENT_PATTERNS.test(url) || SEGMENT_URL_PATTERNS.some(p => p.test(url)) || contentType.includes('mp2t');
  if (isSegment) {
    handleSegmentRequest(details, url, contentType);
    return;
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
    quality: streamType === 'hls' ? 'HLS Stream' : streamType === 'dash' ? 'DASH Stream' : null,
    variants: [],
    audioRenditions: [],
    subtitles: [],
    isEncrypted: false,
    isLive: false,
    totalDuration: 0,
    segmentCount: 0,
    parsed: false,
    referer: details.initiator || details.documentUrl || null,
    timestamp: Date.now()
  };
  // For subtitle files, extract format info
  if (mediaType === 'subtitle') {
    const ext = url.match(/\.(vtt|srt|ass|ssa|sub|ttml)/i);
    item.quality = ext ? ext[1].toUpperCase() + ' Subtitle' : 'Subtitle';
    item.subtitleFormat = ext ? ext[1].toLowerCase() : 'vtt';
  }
  // Register media item immediately so it is instantly visible in the popup (0ms delay)
  tabMedia.set(id, item);
  updateBadge(details.tabId);
  notifyPopup(details.tabId);

  // Parse streaming manifests asynchronously in the background without blocking detection
  if (streamType === 'hls' || streamType === 'dash') {
    (async () => {
      try {
        const manifestContent = await fetchManifest(url, item.referer);
        if (manifestContent) {
          if (streamType === 'hls') {
            await parseHLSManifest(item, manifestContent, url);
          } else {
            parseDASHManifest(item, manifestContent, url);
          }
          item.parsed = true;
          tabMedia.set(id, item);
          updateBadge(details.tabId);
          notifyPopup(details.tabId);
        }
      } catch (err) {
        console.warn(`[MediaSniff] Background parse for ${streamType} manifest completed with note:`, err.message);
      }
    })();
  }
}

function handleSegmentRequest(details, url, contentType) {
  if (details.tabId < 0) return;
  const tabMedia = getTabMedia(details.tabId);
  const segUrl = url;

  // 1. Check if an existing HLS stream on this tab belongs to this CDN/host
  for (const m of tabMedia.values()) {
    if (m.streamType === 'hls') {
      try {
        const segHost = new URL(segUrl).hostname;
        const streamHost = new URL(m.url).hostname;
        if (segHost === streamHost) {
          if (!m.segments) m.segments = [];
          if (!m.segments.includes(segUrl)) {
            m.segments.push(segUrl);
            m.segmentCount = m.segments.length;
            if (!m.quality || m.quality === 'HLS Stream') m.quality = `${m.segments.length} segments`;
            updateBadge(details.tabId);
            notifyPopup(details.tabId, 5000);
          }
          return;
        }
      } catch (_) {}
    }
  }

  // 2. Check for duplicate directory path to group segments cleanly
  let dirKey = '';
  try {
    const u = new URL(url);
    dirKey = u.origin + u.pathname.replace(/\/[^/]+$/, '');
  } catch (_) {}

  const existingPathItem = Array.from(tabMedia.values()).find(m => {
    try {
      const u = new URL(m.url);
      const mDir = u.origin + u.pathname.replace(/\/[^/]+$/, '');
      return dirKey && mDir === dirKey;
    } catch (_) {
      return false;
    }
  });

  if (existingPathItem) {
    if (!existingPathItem.segments) existingPathItem.segments = [];
    if (!existingPathItem.segments.includes(segUrl)) {
      existingPathItem.segments.push(segUrl);
      existingPathItem.segmentCount = existingPathItem.segments.length;
      if (!existingPathItem.quality || existingPathItem.quality === 'HLS Stream') {
        existingPathItem.quality = `${existingPathItem.segments.length} segments`;
      }
      updateBadge(details.tabId);
      notifyPopup(details.tabId, 5000);
    }
    return;
  }

  // 3. Register newly discovered live HLS stream from intercepted segment
  const id = `media_${++idCounter}`;
  const filename = extractFilename(url, 'application/x-mpegurl').replace(/\.(ts|m4s)$/i, '') || 'Live Video Stream';
  const item = {
    id,
    url: segUrl,
    type: 'stream',
    streamType: 'hls',
    mimeType: 'application/x-mpegurl',
    contentLength: 0,
    sizeLabel: 'HLS',
    filename: filename,
    quality: '1 segment detected',
    variants: [],
    audioRenditions: [],
    subtitles: [],
    isEncrypted: false,
    isLive: true,
    totalDuration: 0,
    segmentCount: 1,
    segments: [segUrl],
    parsed: false,
    referer: details.initiator || details.documentUrl || null,
    timestamp: Date.now()
  };

  tabMedia.set(id, item);
  updateBadge(details.tabId);
  notifyPopup(details.tabId);

  tryUpgradeSegmentToPlaylist(item, segUrl, details.tabId).catch(() => {});
}

async function tryUpgradeSegmentToPlaylist(item, segUrl, tabId) {
  let u;
  try { u = new URL(segUrl); } catch (_) { return; }
  const query = u.search || '';
  const candidates = [];

  const addCandidate = (candUrl) => {
    try {
      const full = new URL(candUrl).href;
      if (full !== segUrl && !candidates.includes(full)) candidates.push(full);
    } catch (_) {}
  };

  // 1. Domain/Path-specific patterns (Vimeo / Akamai / CDNs)
  if (segUrl.includes('vimeocdn.com') || segUrl.includes('vimeo')) {
    const p = u.pathname;
    const cleanCand = (newPath) => u.origin + newPath + query;
    if (p.includes('/avf/')) {
      addCandidate(cleanCand(p.replace(/\/avf\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/avf\/.*$/, '/master.m3u8')));
      addCandidate(cleanCand(p.replace(/\/avf\/.*$/, '/playlist.m3u8')));
      addCandidate(cleanCand(p.replace(/\/[^/]+\/avf\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/[^/]+\/avf\/.*$/, '/master.m3u8')));
    }
    if (p.includes('/v2/playlist/av/') || p.includes('/playlist/av/')) {
      addCandidate(cleanCand(p.replace(/\/(?:v2\/)?playlist\/av\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/(?:v2\/)?playlist\/av\/.*$/, '/master.m3u8')));
      addCandidate(cleanCand(p.replace(/\/(?:v2\/)?playlist\/av\/.*$/, '/playlist.m3u8')));
    }
    if (p.includes('/parcel/video/') || p.includes('/parcel/audio/')) {
      addCandidate(cleanCand(p.replace(/\/parcel\/(?:video|audio)\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/parcel\/(?:video|audio)\/.*$/, '/master.m3u8')));
      addCandidate(cleanCand(p.replace(/\/parcel\/(?:video|audio)\/.*$/, '/playlist.m3u8')));
    }
  }

  // 2. Universal relative candidates for ANY HLS stream
  const relativeTemplates = [
    'playlist.m3u8',
    'master.m3u8',
    'index.m3u8',
    'live.m3u8',
    '../playlist.m3u8',
    '../master.m3u8',
    '../index.m3u8',
    '../../playlist.m3u8',
    '../../master.m3u8',
    '../../index.m3u8',
    '../../../master.m3u8',
    '../../../master.json'
  ];

  for (const rel of relativeTemplates) {
    try {
      const cand = new URL(rel + query, segUrl).href;
      addCandidate(cand);
    } catch (_) {}
  }

  for (const cand of candidates) {
    try {
      const content = await fetchManifest(cand, item.referer);
      if (content && (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXTM3U') || content.trim().startsWith('{'))) {
        await parseHLSManifest(item, content, cand);
        item.url = cand;
        item.parsed = true;
        if (item.variants?.length > 0) {
          item.quality = item.variants[0].label;
          item.isLive = false;
        }
        const tabMedia = getTabMedia(tabId);
        tabMedia.set(item.id, item);
        updateBadge(tabId);
        notifyPopup(tabId);
        break;
      }
    } catch (_) {}
  }
}
// ─── HLS Manifest Parsing ───────────────────────────────────────────
async function parseHLSManifest(item, content, url) {
  if (!content) return;
  const trimmed = content.trim();

  // Support Vimeo master.json format
  if (trimmed.startsWith('{') && (url.includes('master.json') || trimmed.includes('"video"') || trimmed.includes('"base_url"'))) {
    try {
      const json = JSON.parse(trimmed);
      const baseUrl = json.base_url ? new URL(json.base_url, url).href : url;
      if (Array.isArray(json.video) && json.video.length > 0) {
        item.variants = json.video.map(v => ({
          url: v.url ? new URL(v.url, baseUrl).href : (v.id ? `${baseUrl}${v.id}` : ''),
          bandwidth: v.avg_bitrate || v.bitrate || 0,
          resolution: v.width && v.height ? `${v.width}x${v.height}` : null,
          width: v.width || 0,
          height: v.height || 0,
          codecs: v.codecs || 'h264',
          label: `${v.height || 'Video'}p · ${Math.round((v.avg_bitrate || v.bitrate || 0) / 1000)} Kbps`,
          segments: Array.isArray(v.segments) ? v.segments.map(s => new URL(s.url || s, baseUrl).href) : null,
          initUrl: v.init_segment ? (v.init_segment.startsWith('data:') ? v.init_segment : new URL(v.init_segment, baseUrl).href) : null
        })).filter(v => v.url);
        if (Array.isArray(json.audio) && json.audio.length > 0) {
          item.audioRenditions = json.audio.map((a, i) => ({
            url: a.url ? new URL(a.url, baseUrl).href : (a.id ? `${baseUrl}${a.id}` : ''),
            name: a.id || a.title || `Track ${i + 1}`,
            language: a.codecs || a.lang || 'default',
            isDefault: i === 0,
            segments: Array.isArray(a.segments) ? a.segments.map(s => new URL(s.url || s, baseUrl).href) : null,
            initUrl: a.init_segment ? (a.init_segment.startsWith('data:') ? a.init_segment : new URL(a.init_segment, baseUrl).href) : null
          })).filter(a => a.url);
        }
        item.quality = item.variants[0]?.label || 'Master HLS';
        item.sizeLabel = 'HLS';
        item.isLive = false;
        item.parsed = true;
        return;
      }
    } catch (e) {
      console.warn('[MediaSniff] Failed to parse JSON manifest in parseHLSManifest:', e.message);
    }
  }

  const parsed = HLSParser.parse(content, url);
  if (parsed.type === 'master') {
    item.variants = parsed.variants.map(v => ({
      url: v.url,
      bandwidth: v.bandwidth,
      resolution: v.resolution,
      width: v.width,
      height: v.height,
      codecs: v.codecs,
      label: v.label,
      segments: v.segments || null,
      initUrl: v.initSegment || null
    }));
    item.audioRenditions = parsed.audioRenditions.map(a => ({
      url: a.uri,
      name: a.name,
      language: a.language,
      isDefault: a.isDefault,
      segments: a.segments || null,
      initUrl: a.initSegment || null
    }));
    item.quality = item.variants.length > 0 ? item.variants[0].label : null;
    item.isLive = false;
    item.parsed = true;
  } else {
    // Media playlist
    item.segmentCount = parsed.segmentCount;
    item.totalDuration = parsed.totalDuration;
    item.isLive = parsed.isLive;
    item.isEncrypted = parsed.isEncrypted;
    item.quality = `${parsed.segmentCount} segments · ${formatDuration(parsed.totalDuration)}`;
    item.segments = parsed.segments;
    item.initUrl = parsed.initSegment || null;
    item.parsed = true;

    // Check if we can probe and auto-upgrade to master playlist asynchronously
    tryUpgradeToMasterPlaylist(item, url).catch(() => {});
  }
}

async function tryUpgradeToMasterPlaylist(item, url) {
  let u;
  try { u = new URL(url); } catch (_) { return; }
  const query = u.search || '';
  const candidates = [];

  const addCandidate = (candUrl) => {
    try {
      const full = new URL(candUrl).href;
      if (full !== url && !candidates.includes(full)) candidates.push(full);
    } catch (_) {}
  };

  if (url.includes('vimeocdn.com') || url.includes('vimeo')) {
    const p = u.pathname;
    const cleanCand = (newPath) => u.origin + newPath + query;
    if (p.includes('/avf/')) {
      addCandidate(cleanCand(p.replace(/\/avf\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/avf\/.*$/, '/master.m3u8')));
      addCandidate(cleanCand(p.replace(/\/avf\/.*$/, '/playlist.m3u8')));
      addCandidate(cleanCand(p.replace(/\/[^/]+\/avf\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/[^/]+\/avf\/.*$/, '/master.m3u8')));
    }
    if (p.includes('/v2/playlist/av/') || p.includes('/playlist/av/')) {
      addCandidate(cleanCand(p.replace(/\/(?:v2\/)?playlist\/av\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/(?:v2\/)?playlist\/av\/.*$/, '/master.m3u8')));
      addCandidate(cleanCand(p.replace(/\/(?:v2\/)?playlist\/av\/.*$/, '/playlist.m3u8')));
    }
    if (p.includes('/parcel/video/') || p.includes('/parcel/audio/')) {
      addCandidate(cleanCand(p.replace(/\/parcel\/(?:video|audio)\/.*$/, '/master.json')));
      addCandidate(cleanCand(p.replace(/\/parcel\/(?:video|audio)\/.*$/, '/master.m3u8')));
      addCandidate(cleanCand(p.replace(/\/parcel\/(?:video|audio)\/.*$/, '/playlist.m3u8')));
    }
  }

  const relativeTemplates = [
    '../master.m3u8',
    'master.m3u8',
    '../playlist.m3u8',
    '../../master.m3u8',
    '../../playlist.m3u8',
    '../../../master.m3u8',
    '../../../master.json'
  ];

  for (const rel of relativeTemplates) {
    try {
      const cand = new URL(rel + query, url).href;
      addCandidate(cand);
    } catch (_) {}
  }

  for (const cand of candidates) {
    try {
      const candContent = await fetchManifest(cand, item.referer);
      if (candContent && (candContent.includes('#EXT-X-STREAM-INF') || candContent.includes('#EXTM3U') || candContent.trim().startsWith('{'))) {
        await parseHLSManifest(item, candContent, cand);
        if (item.variants?.length > 0) {
          item.url = cand;
          item.parsed = true;
          item.quality = item.variants[0].label;
          item.isLive = false;
          console.log(`[MediaSniff] Successfully upgraded playlist to master: ${cand}`);
          break;
        }
      }
    } catch (_) {}
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
    (async () => {
      try {
        let tabMedia = mediaRegistry.get(tabId);
        if (!tabMedia || tabMedia.size === 0) {
          tabMedia = await restoreTabMedia(tabId);
        }
        sendResponse({ media: tabMedia ? Array.from(tabMedia.values()) : [] });
      } catch (err) {
        console.warn('[MediaSniff] Error handling GET_MEDIA:', err);
        sendResponse({ media: [] });
      }
    })();
    return true;
  }
  if (message.type === 'CLEAR_MEDIA') {
    mediaRegistry.delete(message.tabId);
    clearTabMediaStorage(message.tabId);
    updateBadge(message.tabId);
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'MANIFEST_DETECTED') {
    if (sender.tab) {
      const tabId = sender.tab.id;
      handleManifestDetected({
        tabId,
        url: message.url,
        content: message.content,
        manifestType: message.manifestType || 'hls',
        pageUrl: message.pageUrl || sender.tab.url,
        title: message.title
      });
    }
    return true;
  }
  if (message.type === 'DOM_MEDIA') {
    if (sender.tab) {
      const tabId = sender.tab.id;
      for (const mediaUrl of message.urls) {
        if (mediaUrl.toLowerCase().includes('.m3u8')) {
          handleManifestDetected({
            tabId,
            url: mediaUrl,
            manifestType: 'hls',
            pageUrl: sender.tab.url
          });
          continue;
        }
        if (mediaUrl.toLowerCase().includes('.mpd')) {
          handleManifestDetected({
            tabId,
            url: mediaUrl,
            manifestType: 'dash',
            pageUrl: sender.tab.url
          });
          continue;
        }
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

        if (embed.type === 'vimeo') {
          resolveVimeoConfig(embed.id, sender.tab.url || embed.url, tabId, embed.title);
          continue;
        }

        // Deduplicate: check if this YouTube ID is already registered or URL exists
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
              thumbnail: null,
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
  // Vimeo player data from content script
  if (message.type === 'VIMEO_DATA') {
    if (sender.tab) {
      const tabId = sender.tab.id;
      const { vimeoId, title, duration, thumbnail, masterHlsUrl, progressive, pageUrl } = message;
      const tabMedia = getTabMedia(tabId);

      // Clean up any existing dummy / stub items for this video
      for (const [mId, m] of tabMedia.entries()) {
        if (m.source === 'vimeo' && m.vimeoId === vimeoId) {
          tabMedia.delete(mId);
        } else if (vimeoId && m.url && m.url.includes(vimeoId) && m.streamType === 'direct' && !m.url.includes('.mp4')) {
          tabMedia.delete(mId);
        } else if (m.url && m.url.includes('skyfire.vimeocdn.com') && (!m.variants || m.variants.length === 0)) {
          tabMedia.delete(mId);
        }
      }

      const id = `media_${++idCounter}`;
      const smartFilename = sanitizeFilename(title) || 'Vimeo Video';

      const item = {
        id,
        url: masterHlsUrl || (progressive?.[0]?.url || ''),
        type: masterHlsUrl ? 'stream' : 'video',
        streamType: masterHlsUrl ? 'hls' : 'direct',
        mimeType: masterHlsUrl ? 'application/x-mpegurl' : (progressive?.[0]?.mime || 'video/mp4'),
        contentLength: 0,
        sizeLabel: masterHlsUrl ? 'HLS' : 'MP4',
        filename: smartFilename,
        quality: null,
        variants: [],
        audioRenditions: [],
        subtitles: [],
        isEncrypted: false,
        isLive: false,
        totalDuration: duration,
        segmentCount: 0,
        parsed: false,
        source: 'vimeo',
        vimeoId,
        thumbnail,
        referer: pageUrl,
        directMp4Urls: {},
        progressive: progressive || [],
        timestamp: Date.now()
      };

      if (progressive) {
        for (const prog of progressive) {
          if (prog.height && prog.url) {
            item.directMp4Urls[String(prog.height)] = prog.url;
            item.directMp4Urls[prog.quality] = prog.url;
          }
        }
      }

      if (masterHlsUrl) {
        fetchManifest(masterHlsUrl, pageUrl).then(async (manifestContent) => {
          await parseHLSManifest(item, manifestContent, masterHlsUrl);
          item.parsed = true;
          tabMedia.set(id, item);
          updateBadge(tabId);
          notifyPopup(tabId);
        }).catch((err) => {
          console.warn('[MediaSniff] Failed to fetch Vimeo master manifest:', err.message);
          if (progressive && progressive.length > 0) {
            item.streamType = 'direct';
            item.type = 'video';
            item.variants = progressive.map(p => ({
              url: p.url,
              resolution: `${p.width}x${p.height}`,
              width: p.width,
              height: p.height,
              label: p.quality || `${p.height}p`,
              isDirect: true
            }));
            item.quality = item.variants[0]?.label || 'Direct MP4';
            item.parsed = true;
          }
          tabMedia.set(id, item);
          updateBadge(tabId);
          notifyPopup(tabId);
        });
      } else if (progressive && progressive.length > 0) {
        item.variants = progressive.map(p => ({
          url: p.url,
          resolution: `${p.width}x${p.height}`,
          width: p.width,
          height: p.height,
          label: p.quality || `${p.height}p`,
          isDirect: true
        }));
        item.quality = item.variants[0]?.label || 'Direct MP4';
        item.parsed = true;
        tabMedia.set(id, item);
        updateBadge(tabId);
        notifyPopup(tabId);
      }
    }
    return true;
  }
  if (message.type === 'RESOLVE_VIMEO_EMBED') {
    const tabId = sender.tab?.id;
    if (tabId) {
      resolveVimeoConfig(message.vimeoId, message.pageUrl, tabId, message.title, message.search || '');
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
  // Fetch manifest on behalf of offscreen document with full service worker network privileges & DNR rules
  if (message.type === 'FETCH_MANIFEST') {
    (async () => {
      try {
        const text = await fetchManifest(message.url, message.referer);
        sendResponse({ success: true, text });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  // Start background download (opens offscreen document and delegates task)
  if (message.type === 'START_DOWNLOAD') {
    const { itemId, item, downloadType, options } = message;
    (async () => {
      const referer = item?.referer || options?.referer || null;
      const involvedUrls = [item?.url];
      const qualityIndex = options?.qualityIndex !== undefined ? parseInt(options.qualityIndex) : 0;
      const audioIndex = options?.audioIndex !== undefined ? parseInt(options.audioIndex) : 0;
      
      const selectedVariant = item?.variants?.[qualityIndex];
      if (selectedVariant?.url) involvedUrls.push(selectedVariant.url);
      const selectedAudio = item?.audioRenditions?.[audioIndex];
      if (selectedAudio?.url) involvedUrls.push(selectedAudio.url);

      if (referer) {
        await setDownloadHeadersRule(item?.url || selectedVariant?.url, referer, involvedUrls);
      }

      // Check if any card on this tab or any tab already has segments for variant
      if (selectedVariant && (!selectedVariant.segments || selectedVariant.segments.length === 0)) {
        for (const mediaMap of mediaRegistry.values()) {
          for (const existingItem of mediaMap.values()) {
            if (existingItem.segments?.length > 0) {
              const urlMatches = existingItem.url === selectedVariant.url ||
                getBaseUrl(existingItem.url) === getBaseUrl(selectedVariant.url) ||
                (selectedVariant.url && existingItem.url.includes(selectedVariant.url.split('?')[0]));
              if (urlMatches) {
                selectedVariant.segments = existingItem.segments;
                selectedVariant.initUrl = existingItem.initUrl;
                console.log('[MediaSniff] Reused pre-sniffed segments from existing card for variant.');
                break;
              }
            }
          }
          if (selectedVariant.segments) break;
        }
      }

      // Pre-fetch variant segments in background service worker if still missing
      if (downloadType === 'stream') {
        if (selectedVariant && (!selectedVariant.segments || selectedVariant.segments.length === 0)) {
          try {
            const vContent = await fetchManifest(selectedVariant.url, referer);
            const vParsed = HLSParser.parse(vContent, selectedVariant.url);
            if (vParsed.segments?.length > 0) {
              selectedVariant.segments = vParsed.segments;
              selectedVariant.initUrl = vParsed.initSegment || null;
            }
          } catch (e) {
            console.warn('[MediaSniff] Failed pre-fetching variant playlist in worker:', e.message);
          }
        } else if ((!item.segments || item.segments.length === 0) && (!item.variants || item.variants.length === 0)) {
          try {
            const mContent = await fetchManifest(item.url, referer);
            const mParsed = HLSParser.parse(mContent, item.url);
            if (mParsed.type === 'media' && mParsed.segments?.length > 0) {
              item.segments = mParsed.segments;
              item.initUrl = mParsed.initSegment || null;
            }
          } catch (e) {
            console.warn('[MediaSniff] Failed pre-fetching stream playlist in worker:', e.message);
          }
        }
      } else if (downloadType === 'mux') {
        if (selectedVariant && (!selectedVariant.segments || selectedVariant.segments.length === 0)) {
          try {
            const vContent = await fetchManifest(selectedVariant.url, referer);
            const vParsed = HLSParser.parse(vContent, selectedVariant.url);
            if (vParsed.segments?.length > 0) {
              selectedVariant.segments = vParsed.segments;
              selectedVariant.initUrl = vParsed.initSegment || null;
            } else if (vParsed.variants?.length > 0) {
              const vSubUrl = vParsed.variants[0].url;
              const vSubContent = await fetchManifest(vSubUrl, referer);
              const vSubParsed = HLSParser.parse(vSubContent, vSubUrl);
              if (vSubParsed.segments?.length > 0) {
                selectedVariant.segments = vSubParsed.segments;
                selectedVariant.initUrl = vSubParsed.initSegment || null;
              }
            }
          } catch (e) {
            console.warn('[MediaSniff] Failed pre-fetching video variant in worker:', e.message);
          }
        }
        if (selectedAudio && selectedAudio.url && (!selectedAudio.segments || selectedAudio.segments.length === 0)) {
          try {
            const aContent = await fetchManifest(selectedAudio.url, referer);
            const aParsed = HLSParser.parse(aContent, selectedAudio.url);
            if (aParsed.segments?.length > 0) {
              selectedAudio.segments = aParsed.segments;
              selectedAudio.initUrl = aParsed.initSegment || null;
            } else if (aParsed.variants?.length > 0) {
              const aSubUrl = aParsed.variants[0].url;
              const aSubContent = await fetchManifest(aSubUrl, referer);
              const aSubParsed = HLSParser.parse(aSubContent, aSubUrl);
              if (aSubParsed.segments?.length > 0) {
                selectedAudio.segments = aSubParsed.segments;
                selectedAudio.initUrl = aSubParsed.initSegment || null;
              }
            }
          } catch (e) {
            console.warn('[MediaSniff] Failed pre-fetching audio rendition in worker:', e.message);
          }
        }
      }

      activeDownloads.set(itemId, {
        itemId,
        status: 'downloading',
        percent: 0,
        statusLabel: 'Preparing...',
        speedLabel: ''
      });
      // Broadcast initial state immediately to popup
      chrome.runtime.sendMessage({
        type: 'BACKGROUND_DOWNLOAD_PROGRESS',
        itemId,
        status: 'downloading',
        percent: 0,
        statusLabel: 'Preparing...',
        speedLabel: ''
      }).catch(() => {});

      await ensureOffscreen();
      chrome.runtime.sendMessage({
        type: 'START_BACKGROUND_DOWNLOAD',
        itemId, item, downloadType, options
      });
    })().catch(err => {
      console.error('[MediaSniff] Failed to start background download:', err);
      activeDownloads.delete(itemId);
      chrome.runtime.sendMessage({
        type: 'BACKGROUND_DOWNLOAD_PROGRESS',
        itemId,
        status: 'failed',
        percent: 0,
        statusLabel: 'Error: ' + err.message,
        speedLabel: ''
      }).catch(() => {});
    });
    sendResponse({ success: true });
    return true;
  }
  // Cancel background download
  if (message.type === 'CANCEL_DOWNLOAD') {
    const { itemId } = message;
    clearDownloadHeadersRule();
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
      clearDownloadHeadersRule();
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
  tabLastOrigin.delete(tabId);
  clearTabMediaStorage(tabId);
});

const tabLastOrigin = new Map();

// Seed tabLastOrigin from currently open tabs
chrome.tabs.query({}, (tabs) => {
  if (tabs) {
    for (const t of tabs) {
      if (t.id && t.url) {
        try {
          tabLastOrigin.set(t.id, new URL(t.url).origin);
        } catch (_) {}
      }
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    try {
      const newOrigin = new URL(changeInfo.url).origin;
      const oldOrigin = tabLastOrigin.get(tabId);
      tabLastOrigin.set(tabId, newOrigin);
      // If user navigates to a different site/origin, clear previous site media
      if (oldOrigin && oldOrigin !== newOrigin) {
        console.log(`[MediaSniff] Tab ${tabId} changed site from ${oldOrigin} to ${newOrigin}, clearing media.`);
        mediaRegistry.delete(tabId);
        clearTabMediaStorage(tabId);
        updateBadge(tabId);
        notifyPopup(tabId);
      }
    } catch (_) {}
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
    target: { tabId, allFrames: true },
    files: ['content/content.js']
  }).catch(() => {});
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/inject.js'],
    world: 'MAIN'
  }).catch(() => {});
}
// ─── Helpers ────────────────────────────────────────────────────────
function getStorageKey(tabId) {
  return `tab_media_${tabId}`;
}

async function persistTabMedia(tabId) {
  await storageInitPromise;
  const tabMedia = mediaRegistry.get(tabId);
  const items = tabMedia ? Array.from(tabMedia.values()) : [];
  const key = getStorageKey(tabId);
  const storage = chrome.storage?.session || chrome.storage?.local;
  if (!storage) return;

  if (items.length === 0) {
    storage.remove(key).catch(() => {});
  } else {
    storage.set({ [key]: items }).catch(() => {});
  }
}

async function restoreTabMedia(tabId) {
  const key = getStorageKey(tabId);
  try {
    const storage = chrome.storage?.session || chrome.storage?.local;
    if (storage) {
      const res = await storage.get(key);
      if (res && Array.isArray(res[key]) && res[key].length > 0) {
        const map = new Map();
        for (const item of res[key]) {
          map.set(item.id, item);
        }
        mediaRegistry.set(tabId, map);
        return map;
      }
    }
  } catch (_) {}
  return mediaRegistry.get(tabId) || null;
}

function clearTabMediaStorage(tabId) {
  const key = getStorageKey(tabId);
  const storage = chrome.storage?.session || chrome.storage?.local;
  if (storage) {
    storage.remove(key).catch(() => {});
  }
}

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
  if (count > 0) {
    persistTabMedia(tabId);
  } else {
    clearTabMediaStorage(tabId);
  }
}

const popupNotifyTimers = new Map();
function notifyPopup(tabId, debounceMs = 0) {
  if (debounceMs <= 0) {
    if (popupNotifyTimers.has(tabId)) {
      clearTimeout(popupNotifyTimers.get(tabId));
      popupNotifyTimers.delete(tabId);
    }
    chrome.runtime.sendMessage({ type: 'MEDIA_UPDATED', tabId }).catch(() => { });
    return;
  }

  if (popupNotifyTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    popupNotifyTimers.delete(tabId);
    chrome.runtime.sendMessage({ type: 'MEDIA_UPDATED', tabId }).catch(() => { });
  }, debounceMs);
  popupNotifyTimers.set(tabId, timer);
}
async function fetchManifest(url, referer = null) {
  if (referer) {
    try {
      await setDownloadHeadersRule(url, referer);
    } catch (_) {}
  }

  // 1. Try with credentials (required for Vimeo and session/cookie-gated platforms)
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (response.ok) {
      return await response.text();
    }
  } catch (_) {}

  // 2. Try standard fetch without credentials (for public HLS/CORS wildcard streams)
  try {
    const response = await fetch(url);
    if (response.ok) {
      return await response.text();
    }
    throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    throw err;
  }
}

// ─── Declarative Net Request Header Rules ───────────────────────────
const DNR_RULE_IDS = Array.from({ length: 20 }, (_, i) => 1001 + i);

async function setDownloadHeadersRule(url, referer, extraUrls = []) {
  if (!chrome.declarativeNetRequest || !referer) return;
  try {
    let origin = referer;
    try { origin = new URL(referer).origin; } catch (_) {}

    const domains = new Set();
    const addDomain = (u) => {
      try {
        if (u) domains.add(new URL(u).hostname);
      } catch (_) {}
    };
    addDomain(url);
    if (Array.isArray(extraUrls)) {
      extraUrls.forEach(addDomain);
    }

    // Include major video CDN domains if any domain or referer touches them
    const allDomainsStr = Array.from(domains).join(' ') + ' ' + (referer || '');
    if (allDomainsStr.includes('vimeo')) {
      domains.add('vimeocdn.com');
      domains.add('akamaized.net');
      domains.add('vimeo.com');
    }

    const rules = [];
    let ruleId = 1001;
    for (const domain of domains) {
      if (ruleId > 1020) break;
      rules.push({
        id: ruleId++,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: referer },
            { header: 'Origin', operation: 'set', value: origin }
          ]
        },
        condition: {
          urlFilter: `||${domain}^`,
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      });
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: DNR_RULE_IDS,
      addRules: rules
    });
  } catch (e) {
    console.warn('[MediaSniff] Failed to set declarativeNetRequest rule:', e.message);
  }
}

async function clearDownloadHeadersRule() {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: DNR_RULE_IDS
    });
  } catch (_) {}
}

// ─── Vimeo Resolution Helpers ───────────────────────────────────────
async function resolveVimeoConfig(vimeoId, refererUrl, tabId, defaultTitle = '', search = '') {
  try {
    const configUrl = `https://player.vimeo.com/video/${vimeoId}/config${search || ''}`;
    if (refererUrl) {
      await setDownloadHeadersRule(configUrl, refererUrl);
    }
    const resp = await fetch(configUrl, {
      credentials: 'include'
    });
    if (resp.ok) {
      const config = await resp.json();
      await processVimeoConfig(config, tabId, refererUrl || `https://vimeo.com/${vimeoId}`, defaultTitle);
    }
  } catch (e) {
    console.warn('[MediaSniff] Failed to resolve Vimeo embed config:', e.message);
  }
}

async function processVimeoConfig(config, tabId, pageUrl, defaultTitle = '') {
  if (!config) return;
  const tabMedia = getTabMedia(tabId);
  const video = config.video || {};
  const files = config.request?.files || video.files || {};
  const vimeoId = String(video.id || '');
  const title = video.title || defaultTitle || 'Vimeo Video';
  const duration = parseInt(video.duration) || 0;
  const thumbs = video.thumbs || {};
  const thumbnail = thumbs['1280'] || thumbs['960'] || thumbs['640'] || thumbs['base'] || (vimeoId ? `https://vumbnail.com/${vimeoId}.jpg` : null);

  const hls = files.hls || {};
  const cdns = hls.cdns || {};

  let masterHlsUrl = null;
  for (const cdnName of Object.keys(cdns)) {
    const cdn = cdns[cdnName];
    if (cdn.avc_url) { masterHlsUrl = cdn.avc_url; break; }
    if (cdn.url && !masterHlsUrl) masterHlsUrl = cdn.url;
  }

  const progressive = (files.progressive || []).map(p => ({
    quality: p.quality || `${p.height}p`,
    height: p.height || 0,
    width: p.width || 0,
    url: p.url || '',
    mime: p.mime || 'video/mp4'
  })).filter(p => p.url);

  if (!masterHlsUrl && progressive.length === 0) return;

  // Clean up any dummy stub cards or raw child playlists for this video
  for (const [mId, m] of tabMedia.entries()) {
    if (m.source === 'vimeo' && m.vimeoId === vimeoId) {
      tabMedia.delete(mId);
    } else if (vimeoId && m.url && m.url.includes(vimeoId) && m.streamType === 'direct' && !m.url.includes('.mp4')) {
      tabMedia.delete(mId);
    } else if (m.url && m.url.includes('skyfire.vimeocdn.com') && (!m.variants || m.variants.length === 0)) {
      tabMedia.delete(mId);
    }
  }

  const id = `media_${++idCounter}`;
  const smartFilename = sanitizeFilename(title) || 'Vimeo Video';

  const item = {
    id,
    url: masterHlsUrl || (progressive[0]?.url || ''),
    type: masterHlsUrl ? 'stream' : 'video',
    streamType: masterHlsUrl ? 'hls' : 'direct',
    mimeType: masterHlsUrl ? 'application/x-mpegurl' : (progressive[0]?.mime || 'video/mp4'),
    contentLength: 0,
    sizeLabel: masterHlsUrl ? 'HLS' : 'MP4',
    filename: smartFilename,
    quality: null,
    variants: [],
    audioRenditions: [],
    subtitles: [],
    isEncrypted: false,
    isLive: false,
    totalDuration: duration,
    segmentCount: 0,
    parsed: false,
    source: 'vimeo',
    vimeoId,
    thumbnail,
    referer: pageUrl,
    directMp4Urls: {},
    progressive: progressive,
    timestamp: Date.now()
  };

  for (const prog of progressive) {
    if (prog.height && prog.url) {
      item.directMp4Urls[String(prog.height)] = prog.url;
      item.directMp4Urls[prog.quality] = prog.url;
    }
  }

  if (masterHlsUrl) {
    try {
      const manifestContent = await fetchManifest(masterHlsUrl, pageUrl);
      await parseHLSManifest(item, manifestContent, masterHlsUrl);
      item.parsed = true;
    } catch (err) {
      console.warn('[MediaSniff] Failed to fetch/parse Vimeo master manifest:', err.message);
    }
  }

  if (item.variants.length === 0 && progressive.length > 0) {
    item.streamType = 'direct';
    item.type = 'video';
    item.variants = progressive.map(p => ({
      url: p.url,
      resolution: `${p.width}x${p.height}`,
      width: p.width,
      height: p.height,
      label: p.quality || `${p.height}p`,
      isDirect: true
    }));
    item.quality = item.variants[0]?.label || 'Direct MP4';
    item.parsed = true;
  }

  tabMedia.set(id, item);
  updateBadge(tabId);
  notifyPopup(tabId);
}

// ─── Universal Manifest Handler ──────────────────────────────────────
async function handleManifestDetected({ tabId, url, content, manifestType, pageUrl, title }) {
  if (!tabId || !url) return;
  const tabMedia = getTabMedia(tabId);
  const baseUrl = getBaseUrl(url);

  // Check if already registered and parsed
  const existing = Array.from(tabMedia.values()).find(m => m.url === url || (m.parsed && m.variants?.length > 0 && getBaseUrl(m.url) === baseUrl));
  if (existing && existing.parsed && existing.variants?.length > 0) {
    return;
  }

  const id = existing ? existing.id : `media_${++idCounter}`;
  const smartFilename = sanitizeFilename(title) || extractFilename(url, manifestType === 'hls' ? 'application/x-mpegurl' : 'application/dash+xml');

  const item = existing || {
    id,
    url,
    type: 'stream',
    streamType: manifestType,
    mimeType: manifestType === 'hls' ? 'application/x-mpegurl' : 'application/dash+xml',
    contentLength: 0,
    sizeLabel: manifestType.toUpperCase(),
    filename: smartFilename,
    quality: manifestType === 'hls' ? 'HLS Stream' : 'DASH Stream',
    variants: [],
    audioRenditions: [],
    subtitles: [],
    isEncrypted: false,
    isLive: false,
    totalDuration: 0,
    segmentCount: 0,
    parsed: false,
    referer: pageUrl || null,
    timestamp: Date.now()
  };

  item.referer = pageUrl || item.referer;

  // Register immediately so the item is instantly visible in the popup
  tabMedia.set(id, item);
  updateBadge(tabId);
  notifyPopup(tabId);

  let manifestContent = content;
  if (manifestContent) {
    try {
      if (manifestType === 'hls') {
        await parseHLSManifest(item, manifestContent, url);
      } else {
        parseDASHManifest(item, manifestContent, url);
      }
      item.parsed = true;

      // Link any pre-sniffed segments into matching variants
      if (item.variants?.length > 0) {
        for (const [mId, m] of tabMedia.entries()) {
          if (mId !== item.id && (!m.variants || m.variants.length === 0)) {
            if (m.segments?.length > 0) {
              const matchVariant = item.variants.find(v => v.url && m.url && (v.url === m.url || getBaseUrl(v.url) === getBaseUrl(m.url) || m.url.includes(v.url.split('?')[0]) || v.url.includes(m.url.split('?')[0])));
              if (matchVariant && !matchVariant.segments) {
                matchVariant.segments = m.segments;
                matchVariant.initUrl = m.initUrl;
              }
            }
          }
        }
      }

      tabMedia.set(id, item);
      updateBadge(tabId);
      notifyPopup(tabId);
    } catch (err) {
      console.warn(`[MediaSniff] Failed to parse ${manifestType} manifest:`, err.message);
    }
  } else {
    // Asynchronously fetch manifest in background without blocking UI
    (async () => {
      try {
        const fetchedContent = await fetchManifest(url, pageUrl);
        if (fetchedContent) {
          if (manifestType === 'hls') {
            await parseHLSManifest(item, fetchedContent, url);
          } else {
            parseDASHManifest(item, fetchedContent, url);
          }
          item.parsed = true;

          if (item.variants?.length > 0) {
            for (const [mId, m] of tabMedia.entries()) {
              if (mId !== item.id && (!m.variants || m.variants.length === 0)) {
                if (m.segments?.length > 0) {
                  const matchVariant = item.variants.find(v => v.url && m.url && (v.url === m.url || getBaseUrl(v.url) === getBaseUrl(m.url) || m.url.includes(v.url.split('?')[0]) || v.url.includes(m.url.split('?')[0])));
                  if (matchVariant && !matchVariant.segments) {
                    matchVariant.segments = m.segments;
                    matchVariant.initUrl = m.initUrl;
                  }
                }
              }
            }
          }

          tabMedia.set(id, item);
          updateBadge(tabId);
          notifyPopup(tabId);
        }
      } catch (e) {
        console.warn(`[MediaSniff] Failed to fetch detected ${manifestType} manifest:`, e.message);
      }
    })();
  }
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