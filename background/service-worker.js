/**
 * MediaSniff — Background Service Worker
 * Core detection engine that monitors network requests for media content.
 */
import { HLSParser } from '../lib/hls-parser.js';
import { DASHParser } from '../lib/dash-parser.js';
import { MSG_TYPE, generateMediaId, ERROR_TYPE, classifyError } from '../shared/protocol.js';

// ─── Native Messaging Bridge ─────────────────────────────────────────
// Single managed connection to the native companion app (coapp.py).
// The service worker is the ONLY context allowed to call connectNative in MV3.
// All other contexts (offscreen, popup) communicate via chrome.runtime messages.
const NATIVE_HOST = 'net.mediasniff.coapp';

class NativeMessagingBridge {
  constructor() {
    this._port = null;
    this._connected = false;
    this._listeners = new Map();    // itemId -> { onMessage, onDone }
    this._pendingPing = null;       // resolve/reject for ping
    this._reconnectTimer = null;
  }

  /** Cancel an ongoing download on the native host */
  cancelDownload(itemId) {
    this._listeners.delete(itemId);
    if (this._connected && this._port) {
      try {
        this._port.postMessage({ action: 'cancel', jobId: itemId });
      } catch (_) {}
    }
  }

  /** Check if native host permission is available */
  async _hasPermission() {
    try {
      return await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
    } catch (_) {
      return false;
    }
  }

  /** Open a persistent port to the native host. Returns true if connected. */
  async connect() {
    if (this._connected && this._port) return true;
    if (!(await this._hasPermission())) return false;

    try {
      this._port = chrome.runtime.connectNative(NATIVE_HOST);
      this._connected = true;

      this._port.onMessage.addListener((msg) => this._handleMessage(msg));
      this._port.onDisconnect.addListener(() => this._handleDisconnect());

      console.log('[MediaSniff NativeBridge] Connected to', NATIVE_HOST);
      return true;
    } catch (e) {
      console.warn('[MediaSniff NativeBridge] Failed to connect:', e.message);
      this._connected = false;
      this._port = null;
      return false;
    }
  }

  /** Send a ping and wait for pong. Resolves true/false. Timeout 3s. */
  async ping() {
    const connected = await this.connect();
    if (!connected) return false;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingPing = null;
        resolve(false);
      }, 3000);

      this._pendingPing = (msg) => {
        clearTimeout(timeout);
        this._pendingPing = null;
        resolve(msg && msg.status === 'pong');
      };

      try {
        this._port.postMessage({ action: 'ping' });
      } catch (e) {
        clearTimeout(timeout);
        this._pendingPing = null;
        resolve(false);
      }
    });
  }

  /** Send a download command to the native app. Returns immediately.
   *  Progress and completion are routed via the listener callbacks. */
  sendDownload(itemId, payload, { onProgress, onComplete, onFailed }) {
    if (!this._connected || !this._port) {
      if (onFailed) onFailed('Native host not connected');
      return false;
    }

    payload.jobId = itemId;
    this._listeners.set(itemId, {
      onMessage: (msg) => {
        if (msg.status === 'progress' && onProgress) {
          onProgress(msg);
        } else if (msg.status === 'complete') {
          this._listeners.delete(itemId);
          if (onComplete) onComplete(msg);
        } else if (msg.status === 'failed') {
          this._listeners.delete(itemId);
          if (onFailed) onFailed(msg.statusLabel || msg.error || 'Native download failed');
        }
      }
    });

    try {
      this._port.postMessage(payload);
      return true;
    } catch (e) {
      this._listeners.delete(itemId);
      if (onFailed) onFailed(e.message);
      return false;
    }
  }

  /** Whether the bridge is currently connected */
  get isConnected() {
    return this._connected;
  }

  /** Internal: route incoming messages to the right listener with correlation safety */
  _handleMessage(msg) {
    // Ping response
    if (msg.status === 'pong' && this._pendingPing) {
      this._pendingPing(msg);
      return;
    }

    // Correlation-safe routing by jobId or itemId
    const targetId = msg.jobId || msg.itemId;
    if (targetId && this._listeners.has(targetId)) {
      const listener = this._listeners.get(targetId);
      if (listener.onMessage) {
        listener.onMessage(msg);
        return;
      }
    }

    // Fallback: route to first listener if no targetId specified
    for (const [, listener] of this._listeners) {
      if (listener.onMessage) {
        listener.onMessage(msg);
        return;
      }
    }

    console.log('[MediaSniff NativeBridge] Unrouted message:', msg);
  }

  /** Internal: handle port disconnect */
  _handleDisconnect() {
    const err = chrome.runtime.lastError;
    console.warn('[MediaSniff NativeBridge] Disconnected:', err?.message || 'unknown');
    this._connected = false;
    this._port = null;

    // Fail all pending listeners with correlation
    for (const [itemId, listener] of this._listeners) {
      if (listener.onMessage) {
        listener.onMessage({ status: 'failed', statusLabel: 'Host disconnected: ' + (err?.message || 'unknown'), jobId: itemId });
      }
    }
    this._listeners.clear();

    // Reject pending ping
    if (this._pendingPing) {
      this._pendingPing({ status: 'pong_failed' });
      this._pendingPing = null;
    }
  }

  /** Disconnect and clean up */
  disconnect() {
    if (this._port) {
      try { this._port.disconnect(); } catch (_) {}
    }
    this._port = null;
    this._connected = false;
    this._listeners.clear();
    this._pendingPing = null;
  }
}

const nativeBridge = new NativeMessagingBridge();

/**
 * Extract cookies for a URL and format them into Netscape HTTP Cookie File format
 * suitable for yt-dlp.
 * SECURITY: Cookie values are never logged or exposed to popup/UI.
 */
async function extractNetscapeCookies(targetUrl) {
  if (!chrome.cookies) return null;
  try {
    const urlObj = new URL(targetUrl);
    const domain = urlObj.hostname;

    // Get cookies for the exact URL
    const urlCookies = await chrome.cookies.getAll({ url: targetUrl });
    
    // Also get domain-level cookies (e.g. for .youtube.com or root domain)
    let domainCookies = [];
    const domainParts = domain.split('.');
    if (domainParts.length >= 2) {
      const rootDomain = domainParts.slice(-2).join('.');
      domainCookies = await chrome.cookies.getAll({ domain: rootDomain });
    }

    // Deduplicate by domain + path + name
    const cookieMap = new Map();
    for (const c of [...domainCookies, ...urlCookies]) {
      const key = `${c.domain}#${c.path}#${c.name}`;
      cookieMap.set(key, c);
    }

    if (cookieMap.size === 0) return null;

    const lines = [
      '# Netscape HTTP Cookie File',
      '# http://curl.haxx.se/rfc/cookie_spec.html',
      '# This is a generated file! Do not edit.'
    ];

    for (const c of cookieMap.values()) {
      let cookieDomain = c.domain || domain;
      const isSubdomain = cookieDomain.startsWith('.') || (domainParts.length > 2 && !cookieDomain.startsWith('.'));
      if (isSubdomain && !cookieDomain.startsWith('.')) {
        cookieDomain = '.' + cookieDomain;
      }
      const includeSubdomains = cookieDomain.startsWith('.') ? 'TRUE' : 'FALSE';
      const path = c.path || '/';
      const isSecure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = c.expirationDate ? Math.round(c.expirationDate) : Math.round(Date.now() / 1000 + 86400);
      const name = c.name;
      const value = c.value;

      lines.push(`${cookieDomain}\t${includeSubdomains}\t${path}\t${isSecure}\t${expiry}\t${name}\t${value}`);
    }

    console.log(`[MediaSniff] Prepared cookie delegation (${cookieMap.size} cookies) for ${domain}`);
    return lines.join('\n') + '\n';
  } catch (err) {
    console.warn('[MediaSniff] Cookie extraction failed:', err.message);
    return null;
  }
}

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
            idCounter = Math.max(idCounter, ...Array.from(map.keys()).map(k => parseInt(k.replace('media_', '')) || 0));
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

  try {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'background/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Media downloading, stream multiplexing, and assembling'
    });
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}
// ─── Media Detection Patterns ───────────────────────────────────────
const MEDIA_EXTENSIONS = /\.(mp4|webm|mkv|avi|mov|flv|wmv|m4v|3gp|ogv)(\?|#|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|aac|ogg|opus|flac|wav|m4a|wma)(\?|#|$)/i;
const HLS_EXTENSIONS = /\.(m3u8)(\?|#|$)/i;
const DASH_EXTENSIONS = /\.(mpd)(\?|#|$)/i;
const SUBTITLE_EXTENSIONS = /\.(vtt|srt|ass|ssa|sub|ttml)(\?|#|$)/i;
// Streaming segments — these are chunks, NOT standalone files
const SEGMENT_PATTERNS = /\.(ts|m4s|m4f|cmfv|cmfa|cmft)(\?|#|$)/i;
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
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);
const inFlightRequests = new Set();
async function handleRequest(details) {
  await storageInitPromise;
  // Skip extension/internal requests
  if (details.tabId < 0) return;
  if (IGNORE_PATTERNS.some(p => p.test(details.url))) return;
  if (details.type === 'image' || details.type === 'stylesheet' || details.type === 'font') return;

  const reqKey = `${details.tabId}_${details.url}`;
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
      // Referer must be set via declarativeNetRequest
      const resp = await fetch(url, { credentials: 'include' });
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
  // ─── Detect or attach individual streaming segments ───────────────
  const isSegment = SEGMENT_PATTERNS.test(url) || SEGMENT_URL_PATTERNS.some(p => p.test(url)) || contentType.includes('mp2t');
  if (isSegment) {
    handleSegmentRequest(details, url, contentType);
    return;
  }
  if (!mediaType) return;
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
    item.audioRenditions = (parsed.audioTracks || parsed.audioRenditions || []).map(a => ({
      url: a.uri || a.url,
      name: a.name,
      language: a.language,
      isDefault: a.isDefault,
      segments: a.segments || null,
      initUrl: a.initSegment || null
    }));
    item.subtitles = (parsed.subtitleTracks || parsed.subtitleRenditions || []).map(s => ({
      url: s.uri || s.url,
      language: s.language || s.name,
      format: 'vtt'
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
async function parseDASHManifest(item, content, url) {
  let parsed = DASHParser.parse(content, url);
  
  if (parsed.needsOffscreenParsing) {
    await ensureOffscreen();
    try {
      parsed = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'PARSE_DASH_OFFSCREEN',
          content,
          url
        }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (response?.error) reject(new Error(response.error));
          else resolve(response?.parsed);
        });
      });
    } catch (e) {
      console.warn('[MediaSniff] Offscreen DASH parsing failed:', e);
      return;
    }
  }

  if (!parsed) return;

  item.totalDuration = parsed.totalDuration;
  item.isLive = parsed.isLive;
  if (parsed.periods && parsed.periods.length > 0) {
    const period = parsed.periods[0];
    // Video variants
    if (period.videoSets && period.videoSets.length > 0) {
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
    if (period.audioSets && period.audioSets.length > 0) {
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
    // Subtitle renditions
    const textSets = period.adaptationSets ? period.adaptationSets.filter(a => a.contentType === 'text' || a.contentType === 'subtitle') : [];
    if (textSets.length > 0) {
      for (const ts of textSets) {
        for (const rep of ts.representations) {
          item.subtitles.push({
            url: rep.baseUrl,
            language: ts.lang || rep.label,
            format: 'vtt'
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
        if (tabId != null && !isNaN(tabId)) {
          let tabMedia = mediaRegistry.get(tabId);
          if (!tabMedia || tabMedia.size === 0) {
            tabMedia = await restoreTabMedia(tabId);
          }
          sendResponse({ media: tabMedia ? Array.from(tabMedia.values()) : [] });
        } else {
          // If no tabId specified, return all items from all active tab registries
          const allItems = [];
          for (const map of mediaRegistry.values()) {
            allItems.push(...map.values());
          }
          sendResponse({ media: allItems });
        }
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
  return;
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
    return;
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
    return;
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
    return;
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
    return;
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

      // Tracking set for fallbacks to avoid duplicate triggers across async events
      if (!globalThis._fallbackTracker) {
        globalThis._fallbackTracker = new Set();
      }
      const fallbackTracker = globalThis._fallbackTracker;

      const broadcastProgress = (status, percent, statusLabel, rawError = null) => {
        let errorType = null;
        if (status === 'complete' || status === 'failed' || status === 'cancelled') {
          activeDownloads.delete(itemId);
          fallbackTracker.delete(itemId);
        }
        if (status === 'failed') {
          const classified = classifyError(statusLabel, rawError);
          statusLabel = classified.message;
          errorType = classified.type;
        }
        chrome.runtime.sendMessage({
          type: 'BACKGROUND_DOWNLOAD_PROGRESS',
          itemId,
          status,
          percent,
          statusLabel,
          speedLabel: '',
          errorType
        }).catch(() => {});
      };

      const triggerBrowserFallback = async (reason, fallbackType = 'youtube') => {
        if (fallbackTracker.has(itemId)) {
          console.log('[MediaSniff] Fallback already active for item:', itemId);
          return;
        }
        fallbackTracker.add(itemId);
        console.warn(`[MediaSniff] Triggering in-browser fallback (${fallbackType}) for ${itemId}: ${reason}`);
        try {
          await ensureOffscreen();
          await new Promise(r => setTimeout(r, 200));
          chrome.runtime.sendMessage({
            type: 'START_BACKGROUND_DOWNLOAD',
            itemId,
            item,
            downloadType: fallbackType,
            options
          });
        } catch (fallbackErr) {
          fallbackTracker.delete(itemId);
          broadcastProgress('failed', 0, 'In-browser fallback failed: ' + fallbackErr.message, fallbackErr);
        }
      };

      // Source-aware routing (Phase C):
      // 1. YouTube / yt-dlp:
      //    ├─ Native available → native yt-dlp
      //    └─ Native unavailable → existing browser YouTube pipeline
      const isYouTube = downloadType === 'youtube' || downloadType === 'ytdlp' || item.source === 'youtube' || (item.url && item.url.includes('youtube.com'));

      // 2. Authenticated / Native-Required HLS / DASH:
      //    ├─ Native available → native yt-dlp (streams HLS/DASH manifest with cookies/headers)
      //    └─ Native unavailable → existing browser path (stream/mux)
      const isAuthStream = Boolean(
        downloadType === 'native_stream' ||
        options?.useNative ||
        item.needsAuth ||
        item.requiresNative
      );

      if (isYouTube || isAuthStream) {
        const isNativeAvailable = await nativeBridge.connect();

        if (isNativeAvailable) {
          const targetUrl = item.streamType === 'direct' ? item.url : (item.masterUrl || item.pageUrl || item.url);
          
          // Secure cookie delegation (never logged, never sent to UI)
          const cookies = await extractNetscapeCookies(targetUrl);
          
          const payload = {
            action: 'ytdlp_download',
            jobId: itemId,
            url: targetUrl,
            filename: options.filename || 'download.mp4',
            headers: {
              'User-Agent': navigator.userAgent,
              'Referer': item.pageUrl || item.url || 'https://www.youtube.com/'
            }
          };
          if (cookies) {
            payload.cookies = cookies;
          }

          console.log(`[MediaSniff] Routing ${isYouTube ? 'YouTube' : 'authenticated stream'} to native yt-dlp:`, itemId);
          nativeBridge.sendDownload(itemId, payload, {
            onProgress: (msg) => broadcastProgress('downloading', msg.percent || 0, msg.statusLabel || 'Downloading...'),
            onComplete: (msg) => broadcastProgress('complete', 100, msg.statusLabel || 'Completed by yt-dlp!'),
            onFailed: async (errorMsg) => {
              console.warn('[MediaSniff] Native yt-dlp failed, falling back to browser offscreen pipeline:', errorMsg);
              const fallbackType = isYouTube ? 'youtube' : (downloadType === 'mux' || selectedAudio ? 'mux' : 'stream');
              triggerBrowserFallback(errorMsg, fallbackType);
            }
          });
          return;
        } else if (downloadType === 'ytdlp' || downloadType === 'native_stream') {
          // If the user explicitly clicked an advanced native-only button but companion host is missing
          broadcastProgress('failed', 0, 'Native companion app not installed or not running.', 'NATIVE_UNAVAILABLE');
          return;
        }
        console.log(`[MediaSniff] Native host unavailable; routing ${isYouTube ? 'YouTube' : 'HLS/DASH'} to in-browser pipeline.`);
      }

      // 3. Public / Simple HLS/DASH or Native Fallback:
      //    → existing browser/WASM path
      await ensureOffscreen();
      await new Promise(r => setTimeout(r, 500));
      chrome.runtime.sendMessage({
        type: 'START_BACKGROUND_DOWNLOAD',
        itemId, item, downloadType, options
      });
    })().catch(err => {
      console.error('[MediaSniff] Failed to start background download:', err);
      activeDownloads.delete(itemId);
      const classified = classifyError(err.message, err);
      chrome.runtime.sendMessage({
        type: 'BACKGROUND_DOWNLOAD_PROGRESS',
        itemId,
        status: 'failed',
        percent: 0,
        statusLabel: classified.message,
        speedLabel: '',
        errorType: classified.type
      }).catch(() => {});
    });
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === 'TRIGGER_NATIVE_MUX') {
    const { itemId, videoUrl, audioUrl, filename } = message;
    (async () => {
      try {
        const connected = await nativeBridge.connect();
        if (!connected) {
          sendResponse({ success: false, error: 'Native companion app not installed or not connected.' });
          return;
        }

        // Use a Promise wrapper so sendResponse is called while still valid
        const result = await new Promise((resolve) => {
          nativeBridge.sendDownload(itemId, {
            action: 'download_and_mux',
            jobId: itemId,
            videoUrl,
            audioUrl,
            filename,
            headers: {
              'User-Agent': navigator.userAgent
            }
          }, {
            onProgress: (msg) => {
              chrome.runtime.sendMessage({ type: 'BACKGROUND_DOWNLOAD_PROGRESS', itemId, status: 'downloading', percent: msg.percent || 0, statusLabel: msg.statusLabel || 'Muxing natively...', speedLabel: '' }).catch(() => {});
            },
            onComplete: (msg) => resolve({ success: true, statusLabel: msg.statusLabel || 'Completed by Companion App' }),
            onFailed: (errorMsg) => resolve({ success: false, error: typeof errorMsg === 'string' ? errorMsg : 'Native muxing failed' })
          });
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keep alive for async sendResponse
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
    if (globalThis._fallbackTracker) {
      globalThis._fallbackTracker.delete(itemId);
    }
    if (nativeBridge.isConnected) {
      nativeBridge.cancelDownload(itemId);
    }
    chrome.runtime.sendMessage({
      type: 'BACKGROUND_DOWNLOAD_PROGRESS',
      itemId,
      status: 'cancelled',
      percent: 0,
      statusLabel: 'Download cancelled',
      speedLabel: '',
      errorType: 'CANCELLED'
    }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }
  // Get list of active background downloads
  if (message.type === 'GET_ACTIVE_DOWNLOADS') {
    sendResponse({ downloads: Array.from(activeDownloads.values()) });
    return true;
  }
  // Native companion app status check — popup queries this instead of calling connectNative directly
  if (message.type === 'NATIVE_PING') {
    (async () => {
      try {
        const pong = await nativeBridge.ping();
        sendResponse({ available: pong });
      } catch (e) {
        sendResponse({ available: false });
      }
    })();
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
    chrome.runtime.sendMessage({...message, _forwarded: true}).catch(() => {
      // Popup closed, ignore error
    });
    // Close offscreen document if no more active downloads
    if (activeDownloads.size === 0) {
      setTimeout(async () => {
        if (activeDownloads.size === 0 && await chrome.offscreen.hasDocument()) {
          chrome.offscreen.closeDocument().catch(() => { });
        }
      }, 60000);
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
          const urlObj = new URL(t.url);
          tabLastOrigin.set(t.id, urlObj.origin + urlObj.pathname + urlObj.search);
        } catch (_) {}
      }
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    try {
      const newUrlObj = new URL(changeInfo.url);
      const newUrlPath = newUrlObj.origin + newUrlObj.pathname + newUrlObj.search;
      const oldUrlPath = tabLastOrigin.get(tabId);
      tabLastOrigin.set(tabId, newUrlPath);
      
      // If user navigates to a different page, clear previous media
      if (oldUrlPath && oldUrlPath !== newUrlPath) {
        console.log(`[MediaSniff] Tab ${tabId} navigated from ${oldUrlPath} to ${newUrlPath}, clearing media.`);
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

const pendingPersists = new Map();
function debouncedPersist(tabId) {
  if (pendingPersists.has(tabId)) clearTimeout(pendingPersists.get(tabId));
  pendingPersists.set(tabId, setTimeout(() => {
    pendingPersists.delete(tabId);
    persistTabMedia(tabId);
  }, 500));
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
    debouncedPersist(tabId);
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
let dnrTaskCounter = 0;

async function setDownloadHeadersRule(url, referer, extraUrls = []) {
  if (!chrome.declarativeNetRequest || !referer) return;
  try {
    dnrTaskCounter++;
    const ruleBase = 1000 + (dnrTaskCounter % 100) * 20;
    const ruleIds = Array.from({ length: 20 }, (_, i) => ruleBase + i);
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
    let ruleId = ruleBase;
    for (const domain of domains) {
      if (ruleId >= ruleBase + 20) break;
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
      removeRuleIds: ruleIds,
      addRules: rules
    });
  } catch (e) {
    console.warn('[MediaSniff] Failed to set declarativeNetRequest rule:', e.message);
  }
}

async function clearDownloadHeadersRule() {
  if (!chrome.declarativeNetRequest) return;
  try {
    const allIds = Array.from({ length: 2000 }, (_, i) => 1000 + i);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: allIds
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

  const isSamePlaylistEarly = (url1, url2) => {
    if (!url1 || !url2) return false;
    if (url1 === url2) return true;
    try {
      const u1 = new URL(url1);
      const u2 = new URL(url2);
      if (u1.pathname === u2.pathname) return true;
      return url1.includes(url2.split('?')[0]) || url2.includes(url1.split('?')[0]);
    } catch {
      return url1.includes(url2) || url2.includes(url1);
    }
  };

  // Check if already registered and parsed (even from a different CDN with the same pathname)
  const existing = Array.from(tabMedia.values()).find(m => isSamePlaylistEarly(m.url, url));
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

  // Check if this new URL is a child of an existing master playlist
  let earlyIsChild = false;
  for (const [mId, m] of tabMedia.entries()) {
    if (m.variants?.length > 0) {
      const isVariant = m.variants.some(v => isSamePlaylistEarly(v.url, item.url));
      const isAudio = m.audioRenditions?.some(a => isSamePlaylistEarly(a.url, item.url));
      const isSub = m.subtitles?.some(s => isSamePlaylistEarly(s.url, item.url));
      if (isVariant || isAudio || isSub) {
        earlyIsChild = true;
        break;
      }
    }
  }

  if (earlyIsChild) {
    return; // Don't even add it temporarily
  }

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
                let isChild = false;
                const matchVariant = item.variants.find(v => isSamePlaylistEarly(v.url, m.url));
                if (matchVariant) {
                  isChild = true;
                  if (m.segments?.length > 0 && !matchVariant.segments) {
                    matchVariant.segments = m.segments;
                    matchVariant.initUrl = m.initUrl;
                  }
                }
                const matchAudio = item.audioRenditions?.find(a => isSamePlaylistEarly(a.url, m.url));
                if (matchAudio) {
                  isChild = true;
                  if (m.segments?.length > 0 && !matchAudio.segments) {
                    matchAudio.segments = m.segments;
                    matchAudio.initUrl = m.initUrl;
                  }
                }
                const matchSub = item.subtitles?.find(s => isSamePlaylistEarly(s.url, m.url));
                if (matchSub) {
                  isChild = true;
                }
                if (isChild) {
                  tabMedia.delete(mId);
                }
              }
            }
          } else {
            let isChild = false;
            for (const [mId, m] of tabMedia.entries()) {
              if (mId !== item.id && m.variants?.length > 0) {
                const isVariant = m.variants.some(v => isSamePlaylistEarly(v.url, item.url));
                const isAudio = m.audioRenditions?.some(a => isSamePlaylistEarly(a.url, item.url));
                const isSub = m.subtitles?.some(s => isSamePlaylistEarly(s.url, item.url));
                if (isVariant || isAudio || isSub) {
                  isChild = true;
                  break;
                }
              }
            }
            if (isChild) {
              tabMedia.delete(id);
              updateBadge(tabId);
              notifyPopup(tabId);
              return; // It is a child playlist, remove it from UI
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
    name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const ext = name.match(/\.[^.]+$/)?.[0] || '';
    const stem = name.replace(/\.[^.]+$/, '');
    if (stem.length > 56) name = stem.substring(0, 56) + '...' + ext;
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
  // Remove path separators, illegal filesystem characters, and replace underscores with spaces
  return name
    .replace(/_/g, ' ')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\.\./g, ' ')
    .replace(/^\.+/, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}
function getBaseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const keepParams = ['v', 'id', 'itag', 'mime'];
    const search = new URLSearchParams();
    for (const p of keepParams) {
      if (u.searchParams.has(p)) search.set(p, u.searchParams.get(p));
    }
    const query = search.toString();
    return `${u.origin}${u.pathname}${query ? '?' + query : ''}`;
  } catch {
    return urlStr;
  }
}
