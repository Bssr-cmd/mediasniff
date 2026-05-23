/**
 * MediaSniff — Popup Controller
 * Handles UI rendering, downloads, muxing, and user interactions.
 */

// ─── State ──────────────────────────────────────────────────────────
let currentTabId = null;
let mediaItems = [];
let activeDownloads = new Map();
let pageTitle = '';
let pageUrl = '';
let pageThumbnail = null;

// ─── DOM References ─────────────────────────────────────────────────
const mediaListEl = document.getElementById('mediaList');
const emptyStateEl = document.getElementById('emptyState');
const headerSubtitle = document.getElementById('headerSubtitle');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const clearBtn = document.getElementById('clearBtn');
const toastEl = document.getElementById('toast');

// ─── Icons ──────────────────────────────────────────────────────────
const ICONS = {
  video: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23,7 16,12 23,17"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
  audio: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  subtitle: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`,
  mux: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>`
};

// ─── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    pageTitle = tab.title || '';
    pageUrl = tab.url || '';
  }

  loadMedia();

  // Fetch page thumbnail
  if (currentTabId) {
    chrome.runtime.sendMessage({ type: 'GET_THUMBNAIL', tabId: currentTabId }, (resp) => {
      if (resp?.thumbnail) pageThumbnail = resp.thumbnail;
    });
  }

  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
  });

  clearBtn.addEventListener('click', async () => {
    if (currentTabId) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA', tabId: currentTabId });
      mediaItems = [];
      renderMediaList();
      showToast('Cleared all detected media');
    }
  });

  // Listen for real-time updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'MEDIA_UPDATED' && msg.tabId === currentTabId) {
      loadMedia();
    }
  });
});

// ─── Load Media from Background ─────────────────────────────────────
async function loadMedia() {
  if (!currentTabId) return;
  const response = await chrome.runtime.sendMessage({ type: 'GET_MEDIA', tabId: currentTabId });
  mediaItems = response.media || [];
  renderMediaList();
}

// ─── Render ─────────────────────────────────────────────────────────
function renderMediaList() {
  const count = mediaItems.length;
  headerSubtitle.textContent = count > 0
    ? `${count} media item${count !== 1 ? 's' : ''} detected`
    : 'Scanning for media...';

  if (count === 0) {
    mediaListEl.innerHTML = '';
    emptyStateEl.classList.add('visible');
    return;
  }

  emptyStateEl.classList.remove('visible');
  mediaListEl.innerHTML = '';

  // Sort: streams first, then by size/timestamp
  const sorted = [...mediaItems].sort((a, b) => {
    const typeOrder = { stream: 0, video: 1, audio: 2, subtitle: 3 };
    const ta = typeOrder[a.type] ?? 9;
    const tb = typeOrder[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    return b.timestamp - a.timestamp;
  });

  for (const item of sorted) {
    const card = createMediaCard(item);
    mediaListEl.appendChild(card);
  }
}

// ─── Create Card ────────────────────────────────────────────────────
function createMediaCard(item) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.id = `card-${item.id}`;

  const smartName = getSmartName(item);
  const iconClass = item.type === 'audio' ? 'audio' : item.type === 'subtitle' ? 'subtitle' : '';
  const iconSvg = ICONS[item.type] || ICONS.video;

  let html = `
    <div class="card-header">
      ${item.thumbnail || pageThumbnail ? `
        <div class="card-thumb">
          <img src="${escHtml(item.thumbnail || pageThumbnail)}" alt="" loading="lazy">
        </div>
      ` : ''}
      <div class="media-icon ${iconClass}">${iconSvg}</div>
      <div class="card-info">
        <div class="card-filename" title="${escHtml(smartName)}">${escHtml(smartName)}</div>
        <div class="card-url" title="${escHtml(item.url)}">${escHtml(truncateUrl(item.url))}</div>
      </div>
    </div>
    <div class="card-badges">
      ${item.source === 'youtube' ? '<span class="badge youtube">YOUTUBE</span>' : `<span class="badge ${item.streamType}">${item.streamType.toUpperCase()}</span>`}
      <span class="badge ${item.type}">${item.type.toUpperCase()}</span>
      ${item.sizeLabel && item.sizeLabel !== 'Unknown' ? `<span class="badge size">${item.sizeLabel}</span>` : ''}
      ${item.totalDuration ? `<span class="badge duration">${formatDuration(item.totalDuration)}</span>` : ''}
      ${item.segmentCount > 0 ? `<span class="badge segments">${item.segmentCount} segs</span>` : ''}
      ${item.isEncrypted ? `<span class="badge encrypted">🔒 DRM</span>` : ''}
      ${item.isLive ? `<span class="badge live">● LIVE</span>` : ''}
    </div>`;

  // Quality selector for variants
  if (item.variants && item.variants.length > 1) {
    html += `
    <div class="quality-section">
      <div class="quality-label">Video Quality</div>
      <select class="quality-select" id="quality-${item.id}">
        ${item.variants.map((v, i) => `<option value="${i}">${v.label}${v.resolution ? ' (' + v.resolution + ')' : ''}${v.codecs ? ' [' + v.codecs + ']' : ''}</option>`).join('')}
      </select>
    </div>`;
  }

  // Audio rendition selector
  if (item.audioRenditions && item.audioRenditions.length > 0) {
    html += `
    <div class="audio-section quality-section">
      <div class="quality-label">Audio Track</div>
      <select class="quality-select" id="audio-${item.id}">
        ${item.audioRenditions.map((a, i) => `<option value="${i}">${a.name || a.language || 'Track ' + (i + 1)}${a.label ? ' (' + a.label + ')' : ''}</option>`).join('')}
      </select>
    </div>`;
  }

  // Subtitle embed option
  if (item.subtitles && item.subtitles.length > 0) {
    html += `
    <div class="subtitle-section">
      <label class="subtitle-checkbox-label">
        <input type="checkbox" id="embedSub-${item.id}">
        Download subtitle (${item.subtitles[0].language || item.subtitles[0].filename})
      </label>
    </div>`;
  }

  // Mux section — shown when both video variants and audio renditions exist
  if (item.variants && item.variants.length > 0 && item.audioRenditions && item.audioRenditions.length > 0) {
    html += `
    <div class="mux-section">
      <div class="mux-title">${ICONS.mux} Multiplexer</div>
      <div class="mux-description">Combine video + audio tracks into a single file using in-browser WASM muxing.</div>
      <div class="mux-tracks">
        <div class="mux-track"><div class="mux-track-dot video"></div>Video: <strong>${item.variants[0].label}</strong></div>
        <div class="mux-track"><div class="mux-track-dot audio"></div>Audio: <strong>${item.audioRenditions[0].name || 'Default'}</strong></div>
      </div>
    </div>`;
  }

  // Action buttons
  html += `
    <div class="card-actions">
      ${(item.variants?.length > 0 && item.audioRenditions?.length > 0) ? `
        <button class="btn btn-mux" id="mux-${item.id}" title="Download & combine video+audio">
          ${ICONS.mux} Mux & Download
        </button>
      ` : `
        <button class="btn btn-download" id="dl-${item.id}" title="Download">
          ${ICONS.download} Download
        </button>
      `}
      <button class="btn btn-secondary" id="copy-${item.id}" title="Copy URL">
        ${ICONS.copy}
      </button>
      <button class="btn btn-secondary" id="ytdlp-${item.id}" title="Copy yt-dlp command">
        <span style="font-family:var(--font-mono);font-size:10px;font-weight:600;">yt-dlp</span>
      </button>
    </div>
    <div class="progress-container" id="progress-${item.id}">
      <div class="progress-bar-track"><div class="progress-bar-fill" id="progressFill-${item.id}"></div></div>
      <div class="progress-label">
        <span class="progress-status" id="progressStatus-${item.id}">Preparing...</span>
        <span id="progressPercent-${item.id}">0%</span>
      </div>
    </div>`;

  card.innerHTML = html;

  // ─── Event Listeners ────────────────────────
  // Download button
  const dlBtn = card.querySelector(`#dl-${item.id}`);
  if (dlBtn) {
    dlBtn.addEventListener('click', () => handleDownload(item));
  }

  // Mux button
  const muxBtn = card.querySelector(`#mux-${item.id}`);
  if (muxBtn) {
    muxBtn.addEventListener('click', () => handleMuxDownload(item));
  }

  // Copy URL
  card.querySelector(`#copy-${item.id}`).addEventListener('click', () => {
    const url = getSelectedUrl(item);
    navigator.clipboard.writeText(url);
    showToast('URL copied to clipboard');
  });

  // Copy yt-dlp command
  card.querySelector(`#ytdlp-${item.id}`).addEventListener('click', () => {
    const url = item.streamType === 'direct' ? item.url : getSelectedUrl(item);
    const cmd = `yt-dlp "${url}" -o "${getSmartName(item)}"`;
    navigator.clipboard.writeText(cmd);
    showToast('yt-dlp command copied');
  });

  return card;
}

// ─── Smart Context Naming ───────────────────────────────────────────
function getSmartName(item) {
  let name = '';

  // Try page title first
  if (pageTitle) {
    // Clean up common page title suffixes
    name = pageTitle
      .replace(/\s*[-–—|]\s*(YouTube|Vimeo|Dailymotion|Twitch|Facebook|Twitter|X).*$/i, '')
      .replace(/\s*[-–—|]\s*Watch.*$/i, '')
      .replace(/[<>:"/\\|?*]/g, '')
      .trim();
  }

  // Fallback to URL-based name
  if (!name) {
    try {
      const urlObj = new URL(item.url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      name = pathParts[pathParts.length - 1] || urlObj.hostname;
      name = decodeURIComponent(name.replace(/\.[^.]+$/, ''));
    } catch {
      name = item.filename || 'media';
    }
  }

  // Add quality info
  const qualityIdx = document.getElementById(`quality-${item.id}`)?.value;
  let quality = '';
  if (item.variants && item.variants.length > 0) {
    const idx = qualityIdx ? parseInt(qualityIdx) : 0;
    const v = item.variants[idx];
    if (v.height) quality = `${v.height}p`;
    else if (v.resolution) quality = v.resolution;
  }

  // Determine extension
  let ext = '.mp4';
  if (item.type === 'audio') ext = '.m4a';
  else if (item.type === 'subtitle') ext = '.vtt';
  else if (item.mimeType?.includes('webm')) ext = '.webm';

  // Clean name
  name = name
    .replace(/&/g, 'and')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/[^\w\s_.()-]/g, '');
  if (name.length > 80) name = name.substring(0, 80);

  return quality ? `${name}_(${quality})${ext}` : `${name}${ext}`;
}

// ─── Download Handlers ──────────────────────────────────────────────
async function handleDownload(item) {
  if (item.isEncrypted) {
    showToast('Cannot download DRM-protected content');
    return;
  }

  if (item.streamType === 'direct') {
    // Direct download
    const filename = getSmartName(item);
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT', url: item.url, filename });
    showToast('Download started');
    return;
  }

  // Streaming download — fetch and merge segments
  const progressEl = document.getElementById(`progress-${item.id}`);
  const fillEl = document.getElementById(`progressFill-${item.id}`);
  const statusEl = document.getElementById(`progressStatus-${item.id}`);
  const percentEl = document.getElementById(`progressPercent-${item.id}`);
  const dlBtn = document.getElementById(`dl-${item.id}`);

  progressEl.classList.add('active');
  if (dlBtn) dlBtn.disabled = true;
  statusEl.textContent = 'Fetching manifest...';

  try {
    // Get selected variant
    let targetUrl = item.url;
    let segments = null;
    let initUrl = null;

    const qualitySelect = document.getElementById(`quality-${item.id}`);
    if (qualitySelect && item.variants.length > 0) {
      const variant = item.variants[parseInt(qualitySelect.value)];
      targetUrl = variant.url;

      if (variant.segments) {
        segments = variant.segments;
        initUrl = variant.initUrl;
      }
    }

    // If no segments yet (HLS master → need to fetch media playlist)
    if (!segments) {
      statusEl.textContent = 'Parsing stream...';
      const resp = await fetch(targetUrl);
      const text = await resp.text();
      // Dynamic import for parser
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, targetUrl);
      if (parsed.type === 'media') {
        segments = parsed.segments;
        initUrl = parsed.initSegment?.url || null;
      } else {
        // Nested master, pick first variant
        const firstVariant = parsed.variants[0];
        const resp2 = await fetch(firstVariant.url);
        const text2 = await resp2.text();
        const parsed2 = HLSParser.parse(text2, firstVariant.url);
        segments = parsed2.segments;
        initUrl = parsed2.initSegment?.url || null;
      }
    }

    if (!segments || segments.length === 0) {
      throw new Error('No segments found');
    }

    // Download segments concurrently (8 at a time)
    statusEl.textContent = `Downloading 0/${segments.length} chunks...`;
    const { SegmentDownloader } = await import(chrome.runtime.getURL('lib/segment-downloader.js'));
    const downloader = new SegmentDownloader({
      concurrency: 8,
      onProgress: (p) => {
        fillEl.style.width = `${p.percent}%`;
        percentEl.textContent = `${p.percent}%`;
        statusEl.textContent = `Downloading ${p.completed}/${p.total} chunks${p.speedLabel ? ' · ' + p.speedLabel : ''}`;
      }
    });

    activeDownloads.set(item.id, downloader);
    const result = await downloader.downloadAll(segments, initUrl);

    // Merge segments
    statusEl.textContent = 'Merging segments...';
    fillEl.style.width = '100%';
    const { Transmuxer } = await import(chrome.runtime.getURL('lib/transmuxer.js'));
    const blob = Transmuxer.merge(result.init, result.segments);

    // Trigger download using anchor element (works for any file size)
    const filename = getSmartName(item);
    triggerBlobDownload(blob, filename);
    statusEl.textContent = 'Complete!';
    showToast(`Downloaded: ${filename}`);

  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    fillEl.style.width = '0%';
    showToast(`Download failed: ${err.message}`);
  } finally {
    if (dlBtn) dlBtn.disabled = false;
    activeDownloads.delete(item.id);
  }
}

// ─── Mux Download (Video + Audio) ───────────────────────────────────
async function handleMuxDownload(item) {
  if (item.isEncrypted) {
    showToast('Cannot download DRM-protected content');
    return;
  }

  const progressEl = document.getElementById(`progress-${item.id}`);
  const fillEl = document.getElementById(`progressFill-${item.id}`);
  const statusEl = document.getElementById(`progressStatus-${item.id}`);
  const percentEl = document.getElementById(`progressPercent-${item.id}`);
  const muxBtn = document.getElementById(`mux-${item.id}`);

  progressEl.classList.add('active');
  if (muxBtn) muxBtn.disabled = true;

  try {
    const qualitySelect = document.getElementById(`quality-${item.id}`);
    const audioSelect = document.getElementById(`audio-${item.id}`);
    const videoVariant = item.variants[qualitySelect ? parseInt(qualitySelect.value) : 0];
    const audioRendition = item.audioRenditions[audioSelect ? parseInt(audioSelect.value) : 0];

    const { SegmentDownloader } = await import(chrome.runtime.getURL('lib/segment-downloader.js'));
    const { Transmuxer } = await import(chrome.runtime.getURL('lib/transmuxer.js'));
    const { WASMMuxer } = await import(chrome.runtime.getURL('lib/muxer.js'));

    // ─── Phase 1: Download video segments ───
    statusEl.textContent = 'Downloading video...';
    let videoSegments = videoVariant.segments;
    let videoInitUrl = videoVariant.initUrl;

    if (!videoSegments) {
      const resp = await fetch(videoVariant.url);
      const text = await resp.text();
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, videoVariant.url);
      videoSegments = parsed.segments;
      videoInitUrl = parsed.initSegment?.url;
    }

    const videoDownloader = new SegmentDownloader({
      concurrency: 8,
      onProgress: (p) => {
        const overall = p.percent * 0.4;
        fillEl.style.width = `${overall}%`;
        percentEl.textContent = `${Math.round(overall)}%`;
        statusEl.textContent = `Video: ${p.completed}/${p.total} chunks${p.speedLabel ? ' · ' + p.speedLabel : ''}`;
      }
    });

    const videoResult = await videoDownloader.downloadAll(videoSegments, videoInitUrl);
    const videoBlob = Transmuxer.merge(videoResult.init, videoResult.segments);

    // ─── Phase 2: Download audio segments ───
    statusEl.textContent = 'Downloading audio...';
    let audioSegments = audioRendition.segments;
    let audioInitUrl = audioRendition.initUrl;

    if (!audioSegments && audioRendition.url) {
      const resp = await fetch(audioRendition.url);
      const text = await resp.text();
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, audioRendition.url);
      audioSegments = parsed.segments;
      audioInitUrl = parsed.initSegment?.url;
    }

    let audioBlob;
    if (audioSegments) {
      const audioDownloader = new SegmentDownloader({
        concurrency: 8,
        onProgress: (p) => {
          const overall = 40 + p.percent * 0.3;
          fillEl.style.width = `${overall}%`;
          percentEl.textContent = `${Math.round(overall)}%`;
          statusEl.textContent = `Audio: ${p.completed}/${p.total} chunks${p.speedLabel ? ' · ' + p.speedLabel : ''}`;
        }
      });
      const audioResult = await audioDownloader.downloadAll(audioSegments, audioInitUrl);
      audioBlob = Transmuxer.merge(audioResult.init, audioResult.segments);
    }

    // ─── Phase 3: Mux video + audio ───
    statusEl.textContent = 'Muxing video + audio (WASM)...';
    fillEl.style.width = '75%';
    percentEl.textContent = '75%';

    const videoBuffer = await videoBlob.arrayBuffer();
    const audioBuffer = audioBlob ? await audioBlob.arrayBuffer() : null;

    const muxedBlob = await WASMMuxer.mux(videoBuffer, audioBuffer, (progress) => {
      const overall = 75 + progress * 0.25;
      fillEl.style.width = `${overall}%`;
      percentEl.textContent = `${Math.round(overall)}%`;
    });

    // ─── Phase 4: Download subtitle if selected ───
    const embedSubCheckbox = document.getElementById(`embedSub-${item.id}`);
    if (embedSubCheckbox?.checked && item.subtitles?.length > 0) {
      statusEl.textContent = 'Downloading subtitle...';
      const subUrl = item.subtitles[0].url;
      const subResp = await fetch(subUrl);
      const subBlob = await subResp.blob();
      const subName = getSmartName(item).replace(/\.[^.]+$/, '') + '.' + (item.subtitles[0].format || 'vtt');
      const subDownloadUrl = URL.createObjectURL(subBlob);
      await chrome.downloads.download({ url: subDownloadUrl, filename: subName, saveAs: false });
      setTimeout(() => URL.revokeObjectURL(subDownloadUrl), 30000);
    }

    // ─── Phase 5: Trigger final download ───
    fillEl.style.width = '100%';
    percentEl.textContent = '100%';

    const filename = getSmartName(item);
    triggerBlobDownload(muxedBlob, filename);
    statusEl.textContent = 'Complete!';
    showToast(`Downloaded: ${filename}`);

  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    fillEl.style.width = '0%';
    showToast(`Mux failed: ${err.message}`);
    console.error('[MediaSniff] Mux error:', err);
  } finally {
    if (muxBtn) muxBtn.disabled = false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────
function getSelectedUrl(item) {
  const qualitySelect = document.getElementById(`quality-${item.id}`);
  if (qualitySelect && item.variants?.length > 0) {
    return item.variants[parseInt(qualitySelect.value)].url;
  }
  return item.url;
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (path.length > 50) path = '...' + path.slice(-47);
    return u.hostname + path;
  } catch { return url.slice(0, 60); }
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2500);
}

// Reliable blob download with proper filename — works for any size
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(filename);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Clean up after a delay
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 10000);
}

function sanitizeFilename(name) {
  if (!name) return 'download.mp4';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '')
    .replace(/&/g, 'and')
    .trim()
    .substring(0, 200) || 'download.mp4';
}
