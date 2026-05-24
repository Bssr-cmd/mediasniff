/**
 * MediaSniff — Background Service Worker
 * Core detection engine that monitors network requests for media content.
 */

import { HLSParser } from '../lib/hls-parser.js';
import { DASHParser } from '../lib/dash-parser.js';

// ─── Per-Tab Media Registry ─────────────────────────────────────────
const mediaRegistry = new Map(); // tabId -> Map<id, MediaItem>
let idCounter = 0;

// Load registry from chrome.storage.session
async function loadRegistry() {
  try {
    const data = await chrome.storage.session.get('mediaRegistry');
    const parsed = data.mediaRegistry || {};
    mediaRegistry.clear();
    for (const [tabIdStr, itemsObj] of Object.entries(parsed)) {
      const tabId = parseInt(tabIdStr);
      const tabMap = new Map();
      for (const [itemId, item] of Object.entries(itemsObj)) {
        tabMap.set(itemId, item);
      }
      mediaRegistry.set(tabId, tabMap);
    }
    console.log('[MediaSniff] Registry successfully loaded from session storage:', mediaRegistry);
  } catch (e) {
    console.warn('[MediaSniff] Failed to load session storage registry:', e.message);
  }
}

// Save registry to chrome.storage.session
async function saveRegistry() {
  try {
    const obj = {};
    for (const [tabId, tabMap] of mediaRegistry.entries()) {
      obj[tabId] = Object.fromEntries(tabMap.entries());
    }
    await chrome.storage.session.set({ mediaRegistry: obj });
    console.log('[MediaSniff] Registry successfully saved to session storage.');
  } catch (e) {
    console.warn('[MediaSniff] Failed to save session storage registry:', e.message);
  }
}

// Initialize on background load
loadRegistry();

// ─── Active Background Downloads Registry ────────────────────────────
const activeDownloads = new Map(); // itemId -> taskState
let offscreenCreating = null;

// ─── Captured Headers Registry (for authenticated requests) ─────────
const capturedHeaders = new Map(); // url -> headers

function getResolutionFromItag(itagStr) {
  const itag = parseInt(itagStr);
  const itagMap = {
    // 1080p
    137: '1080', 248: '1080', 399: '1080', 271: '1080', 303: '1080',
    // 720p
    136: '720', 247: '720', 398: '720', 22: '720', 302: '720',
    // 480p
    135: '480', 244: '480', 397: '480',
    // 360p
    134: '360', 243: '360', 396: '360', 18: '360',
    // 240p
    133: '240', 242: '240', 395: '240',
    // 144p
    160: '144', 278: '144', 394: '144',
    // 4K (2160p)
    313: '2160', 401: '2160', 272: '2160',
    // 2K (1440p)
    264: '1440', 270: '1440', 400: '1440'
  };
  return itagMap[itag] || null;
}

const associateStream = (item, streamMime, streamItag, streamUrl, streamHeaders, tabId) => {
  if (!item.directVideoUrls) item.directVideoUrls = {};
  if (!item.directAudioUrls) item.directAudioUrls = {};

  if (streamMime.startsWith('video/')) {
    const format = item.availableQualities?.find(q => q.itag === parseInt(streamItag));
    const height = format ? String(format.height) : (getResolutionFromItag(streamItag) || 'default');
    item.directVideoUrls[height] = {
      url: streamUrl,
      headers: streamHeaders,
      mime: streamMime,
      itag: streamItag
    };
    console.log('[VIDEO STREAM]', {
      quality: height,
      mime: streamMime,
      itag: streamItag,
      tabId,
      url: streamUrl
    });
  } else if (streamMime.startsWith('audio/')) {
    item.directAudioUrls['default'] = {
      url: streamUrl,
      headers: streamHeaders,
      mime: streamMime,
      itag: streamItag
    };
    console.log('[AUDIO STREAM]', {
      mime: streamMime,
      itag: streamItag,
      tabId,
      url: streamUrl
    });
  }

  console.log('[REGISTRY STATE]', {
    directVideoUrls: item.directVideoUrls,
    directAudioUrls: item.directAudioUrls
  });

  saveRegistry();
  notifyPopup(tabId);
};

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
// Capture Request Headers dynamically to support authentication on fetching YouTube CDN streams
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const url = details.url;
    
    // Broad detection
    const isYT = url.includes('googlevideo.com') && 
                 (url.includes('videoplayback') || url.includes('mime=video') || url.includes('mime=audio') || url.includes('sabr'));
                 
    if (isYT) {
      console.log('[INTERCEPT]', url);
      
      const headers = {};
      if (details.requestHeaders) {
        for (const h of details.requestHeaders) {
          headers[h.name] = h.value;
        }
      }
      capturedHeaders.set(url, headers);
      
      // Keep registry size bounded
      if (capturedHeaders.size > 200) {
        const firstKey = capturedHeaders.keys().next().value;
        capturedHeaders.delete(firstKey);
      }

      // Check for itag and mime query parameters directly at request initiation!
      try {
        const urlObj = new URL(url);
        const itag = urlObj.searchParams.get('itag') || '';
        let mime = urlObj.searchParams.get('mime') || '';
        const docid = urlObj.searchParams.get('docid') || '';
        
        if (!mime && itag) {
          const audioItags = ['139', '140', '141', '249', '250', '251', '256', '258', '325', '328'];
          mime = audioItags.includes(itag) ? 'audio/mp4' : 'video/mp4';
        }

        console.log('[ITAG]', itag, 'mime:', mime, 'docid:', docid);
        
        if (mime.startsWith('video/') || mime.startsWith('audio/')) {
          // Find matching YouTube item in registry by docid or Referer video ID
          let targetItem = null;
          let targetTabId = details.tabId;
          
          let videoIdFromReferer = '';
          const refererHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'referer')?.value;
          if (refererHeader) {
            try {
              const rUrl = new URL(refererHeader);
              videoIdFromReferer = rUrl.searchParams.get('v') || '';
            } catch(e) {}
          }
          
          const searchVideoId = (docid && docid.length === 11) ? docid : videoIdFromReferer;
          
          if (searchVideoId && searchVideoId.length === 11) {
            for (const [tId, tabMap] of mediaRegistry.entries()) {
              for (const item of tabMap.values()) {
                if (item.source === 'youtube' && item.youtubeId === searchVideoId) {
                  targetItem = item;
                  targetTabId = tId;
                  break;
                }
              }
              if (targetItem) break;
            }
          }
          
          // If not found by docid, and tabId is valid (>=0), find in this tab
          if (!targetItem && details.tabId >= 0) {
            const tabMedia = getTabMedia(details.tabId);
            targetItem = Array.from(tabMedia.values())
              .filter(m => m.source === 'youtube')
              .sort((a, b) => b.timestamp - a.timestamp)[0];
          }
          
          // If still not found, fallback to active tab!
          if (!targetItem) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs && tabs[0]) {
                const activeTabId = tabs[0].id;
                const tabMedia = getTabMedia(activeTabId);
                let ytItem = Array.from(tabMedia.values())
                  .filter(m => m.source === 'youtube')
                  .sort((a, b) => b.timestamp - a.timestamp)[0];
                
                if (!ytItem) {
                  // Create YouTube item for active tab
                  const u = new URL(tabs[0].url);
                  const videoId = u.searchParams.get('v') || u.pathname.split('/').pop() || docid;
                  if (!videoId || videoId.length !== 11) return;
                  
                  const id = `media_${++idCounter}`;
                  const smartTitle = tabs[0].title
                    ? tabs[0].title.replace(/\s*[-–—|]\s*(YouTube).*$/i, '').trim()
                    : 'YouTube Video';
                    
                  ytItem = {
                    id,
                    tabId: activeTabId,
                    url: tabs[0].url,
                    type: 'video',
                    streamType: 'direct',
                    mimeType: 'video/mp4',
                    contentLength: 0,
                    sizeLabel: 'YouTube',
                    filename: smartTitle,
                    quality: '1080p (HD)',
                    variants: [],
                    audioRenditions: [],
                    subtitles: [],
                    isEncrypted: false,
                    isLive: false,
                    totalDuration: 0,
                    segmentCount: 0,
                    parsed: true,
                    source: 'youtube',
                    youtubeId: videoId,
                    thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                    availableQualities: [
                      { label: '2160p (4K)', height: 2160, width: 3840, itag: 313 },
                      { label: '1440p (2K)', height: 1440, width: 2560, itag: 264 },
                      { label: '1080p (HD)', height: 1080, width: 1920, itag: 137 },
                      { label: '720p (HD)', height: 720, width: 1280, itag: 136 },
                      { label: '480p', height: 480, width: 854, itag: 135 },
                      { label: '360p', height: 360, width: 640, itag: 134 }
                    ],
                    directVideoUrls: {},
                    directAudioUrls: {},
                    timestamp: Date.now()
                  };
                  tabMedia.set(id, ytItem);
                  saveRegistry();
                  updateBadge(activeTabId);
                }
                associateStream(ytItem, mime, itag, url, headers, activeTabId);
              }
            });
          } else {
            // Associated with found item
            associateStream(targetItem, mime, itag, url, headers, targetTabId);
          }
        }
      } catch (err) {
        console.warn('[MediaSniff] Error during early YouTube request interception:', err.message);
      }
    }
  },
  { urls: ['*://*.googlevideo.com/*'] },
  ['requestHeaders', 'extraHeaders']
);

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

  // ─── Check for YouTube/Google Video streams ─────────────────────────
  if (YOUTUBE_VIDEO_PATTERN.test(url)) {
    try {
      const urlObj = new URL(url);
      const urlParams = urlObj.searchParams;
      const itag = urlParams.get('itag') || '';
      let mime = urlParams.get('mime') || contentType || '';

      if (!mime && itag) {
        const audioItags = ['139', '140', '141', '249', '250', '251', '256', '258', '325', '328'];
        mime = audioItags.includes(itag) ? 'audio/mp4' : 'video/mp4';
      }
      
      if (mime.startsWith('video/') || mime.startsWith('audio/')) {
        // Do NOT modify or strip range/sig/n parameters as YouTube CDN uses them for request validation
        const cleanUrl = url;

        // Get captured headers
        const headers = capturedHeaders.get(url) || {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.youtube.com/'
        };
        
        let videoIdFromReferer = '';
        const refererVal = headers['Referer'] || headers['referer'];
        if (refererVal) {
          try {
            const rUrl = new URL(refererVal);
            videoIdFromReferer = rUrl.searchParams.get('v') || '';
          } catch(e) {}
        }

        const docid = urlParams.get('docid') || '';
        const searchVideoId = (docid && docid.length === 11) ? docid : videoIdFromReferer;

        const tabMedia = getTabMedia(details.tabId);
        let ytItem = null;
        
        if (searchVideoId && searchVideoId.length === 11) {
          // Search across all tabs if needed
          for (const tabMap of mediaRegistry.values()) {
            for (const item of tabMap.values()) {
              if (item.source === 'youtube' && item.youtubeId === searchVideoId) {
                ytItem = item;
                break;
              }
            }
            if (ytItem) break;
          }
        }
        
        if (!ytItem) {
          ytItem = Array.from(tabMedia.values())
            .filter(m => m.source === 'youtube')
            .sort((a, b) => b.timestamp - a.timestamp)[0];
        }

        if (!ytItem) {
          chrome.tabs.get(details.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab || !tab.url) return;

            const tabMedia2 = getTabMedia(details.tabId);
            let ytItem2 = Array.from(tabMedia2.values())
              .filter(m => m.source === 'youtube')
              .sort((a, b) => b.timestamp - a.timestamp)[0];

            if (!ytItem2) {
              try {
                const u = new URL(tab.url);
                const videoId = u.searchParams.get('v') || u.pathname.split('/').pop();
                if (!videoId || videoId.length !== 11) return;

                const id = `media_${++idCounter}`;
                const smartTitle = tab.title
                  ? tab.title.replace(/\s*[-–—|]\s*(YouTube).*$/i, '').trim()
                  : 'YouTube Video';

                ytItem2 = {
                  id,
                  tabId: details.tabId,
                  url: tab.url,
                  type: 'video',
                  streamType: 'direct',
                  mimeType: 'video/mp4',
                  contentLength: 0,
                  sizeLabel: 'YouTube',
                  filename: smartTitle,
                  quality: '1080p (HD)',
                  variants: [],
                  audioRenditions: [],
                  subtitles: [],
                  isEncrypted: false,
                  isLive: false,
                  totalDuration: 0,
                  segmentCount: 0,
                  parsed: true,
                  source: 'youtube',
                  youtubeId: videoId,
                  thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                  availableQualities: [
                    { label: '2160p (4K)', height: 2160, width: 3840, bitrate: 15000000, itag: 313 },
                    { label: '1440p (2K)', height: 1440, width: 2560, bitrate: 10000000, itag: 264 },
                    { label: '1080p (HD)', height: 1080, width: 1920, bitrate: 4000000, itag: 137 },
                    { label: '720p (HD)', height: 720, width: 1280, bitrate: 2000000, itag: 136 },
                    { label: '480p', height: 480, width: 854, bitrate: 1000000, itag: 135 },
                    { label: '360p', height: 360, width: 640, bitrate: 500000, itag: 134 }
                  ],
                  directVideoUrls: {},
                  directAudioUrls: {},
                  timestamp: Date.now()
                };

                tabMedia2.set(id, ytItem2);
                updateBadge(details.tabId);
              } catch (e) {
                return;
              }
            }

            associateStream(ytItem2, mime, itag, cleanUrl, headers, details.tabId);
          });
        } else {
          associateStream(ytItem, mime, itag, cleanUrl, headers, details.tabId);
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
  saveRegistry();
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

async function forceYouTubeQuality(tabId, quality) {
  const qualityMap = {
    '2160': 'hd2160',
    '1440': 'hd1440',
    '1080': 'hd1080',
    '720': 'hd720',
    '480': 'large',
    '360': 'medium',
    '240': 'small',
    '144': 'tiny'
  };
  
  const ytQuality = qualityMap[quality] || 'hd1080';
  console.log(`[MediaSniff SW] Injecting quality switch to ${ytQuality} (target quality: ${quality}p) in tab ${tabId}`);
  
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (targetQuality) => {
        try {
          const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
          const video = document.querySelector('video');
          if (player) {
            console.log(`[MediaSniff Injected] Programmatically forcing player quality to: ${targetQuality}`);
            player.setPlaybackQualityRange(targetQuality);
            player.setPlaybackQuality(targetQuality);
            
            if (video) {
              console.log('[MediaSniff Injected] Invalidating video buffer pressure...');
              video.pause();
              const current = video.currentTime;
              video.currentTime = current + 2; // Seek forward 2s to force buffer flush
              
              await new Promise(r => setTimeout(r, 600));
              video.play();
              console.log('[MediaSniff Injected] Buffer flushed and playback resumed successfully.');
            }
          } else {
            console.warn('[MediaSniff Injected] YouTube player not found.');
          }
        } catch (e) {
          console.error('[MediaSniff Injected] Error:', e.message);
        }
      },
      args: [ytQuality]
    });
  } catch (err) {
    console.error('[MediaSniff SW] Failed to execute quality switch script:', err.message);
  }
}

// ─── Content Script Messages ────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FORCE_QUALITY_SWITCH') {
    const { tabId, quality } = message;
    forceYouTubeQuality(tabId, quality).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'GET_MEDIA_ITEM') {
    const tabMedia = getTabMedia(message.tabId);
    const item = tabMedia.get(message.itemId);
    sendResponse({ item: item || null });
    return true;
  }

  if (message.type === 'GET_MEDIA') {
    const tabId = message.tabId;
    const tabMedia = getTabMedia(tabId);
    sendResponse({ media: Array.from(tabMedia.values()) });
    return true;
  }

  if (message.type === 'CLEAR_MEDIA') {
    mediaRegistry.delete(message.tabId);
    saveRegistry();
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
      saveRegistry();
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
      saveRegistry();
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

      // Check if we already have this YouTube video
      const alreadyHas = Array.from(tabMedia.values()).some(m => m.source === 'youtube' && m.youtubeId === info.videoId);
      if (alreadyHas) return true;

      // Build quality info from adaptive formats (no direct URLs — those go through Cobalt API)
      const videoFormats = (message.formats || []).filter(f => f.mimeType.startsWith('video/'));
      const audioFormats = (message.formats || []).filter(f => f.mimeType.startsWith('audio/'));
      const watchUrl = `https://www.youtube.com/watch?v=${info.videoId}`;

      // Build quality label for display (best available)
      const bestVideo = videoFormats.sort((a, b) => b.height - a.height)[0];
      const bestAudio = audioFormats.sort((a, b) => b.bitrate - a.bitrate)[0];
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
        availableQualities: videoFormats.map(f => ({
          label: f.qualityLabel || `${f.height}p`,
          height: f.height,
          width: f.width,
          bitrate: f.bitrate,
          itag: f.itag,
        })),
        timestamp: Date.now()
      });

      saveRegistry();
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
          chrome.offscreen.closeDocument().catch(() => {});
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
  chrome.runtime.sendMessage({ type: 'MEDIA_UPDATED', tabId }).catch(() => {});
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
