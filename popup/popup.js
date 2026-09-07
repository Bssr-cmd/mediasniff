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

let currentMinSize = 0;
let currentQualityPref = 'highest';

// ─── DOM References ─────────────────────────────────────────────────
const mediaListEl = document.getElementById('mediaList');
const emptyStateEl = document.getElementById('emptyState');
const headerSubtitle = document.getElementById('headerSubtitle');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const clearBtn = document.getElementById('clearBtn');
const scanBtn = document.getElementById('scanBtn'); // new
const toastEl = document.getElementById('toast');

// ─── Icons ──────────────────────────────────────────────────────────
const ICONS = {
  video: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23,7 16,12 23,17"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
  audio: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  subtitle: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`,
  mux: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>`,
  rename: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`
};

// ─── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  }
  if (tab) {
    currentTabId = tab.id;
    pageTitle = tab.title || '';
    pageUrl = tab.url || '';
  }

  // Load settings
  const settings = await chrome.storage.local.get({ minSizeFilter: '0', qualityPref: 'highest' });
  currentMinSize = parseInt(settings.minSizeFilter, 10);
  currentQualityPref = settings.qualityPref;
  
  const minSizeSelect = document.getElementById('minSizeFilter');
  const qualitySelect = document.getElementById('qualityPref');
  if (minSizeSelect) minSizeSelect.value = settings.minSizeFilter;
  if (qualitySelect) qualitySelect.value = settings.qualityPref;

  minSizeSelect?.addEventListener('change', (e) => {
    currentMinSize = parseInt(e.target.value, 10);
    chrome.storage.local.set({ minSizeFilter: e.target.value });
    renderMediaList();
  });
  qualitySelect?.addEventListener('change', (e) => {
    currentQualityPref = e.target.value;
    chrome.storage.local.set({ qualityPref: e.target.value });
    renderMediaList();
  });

  // Listen for real-time updates from background immediately with debounce
  let mediaUpdateTimer = null;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'MEDIA_UPDATED' && (!currentTabId || msg.tabId === currentTabId)) {
      if (mediaUpdateTimer) clearTimeout(mediaUpdateTimer);
      mediaUpdateTimer = setTimeout(() => {
        loadMedia();
      }, 300);
    }

    if (msg.type === 'BACKGROUND_DOWNLOAD_PROGRESS') {
      const { itemId, status, percent, statusLabel, speedLabel } = msg;

      if (status === 'complete' || status === 'failed' || status === 'cancelled') {
        activeDownloads.delete(itemId);
        activeDownloads.delete(String(itemId));
      } else {
        const entry = { itemId, status, percent, statusLabel, speedLabel };
        activeDownloads.set(itemId, entry);
        activeDownloads.set(String(itemId), entry);
      }

      const progressEl = document.getElementById(`progress-${itemId}`);
      const fillEl = document.getElementById(`progressFill-${itemId}`);
      const statusEl = document.getElementById(`progressStatus-${itemId}`);
      const percentEl = document.getElementById(`progressPercent-${itemId}`);
      const dlBtn = document.getElementById(`dl-${itemId}`);
      const muxBtn = document.getElementById(`mux-${itemId}`);

      if (status === 'complete' || status === 'failed' || status === 'cancelled') {
        if (progressEl) progressEl.classList.remove('active');
        if (dlBtn) dlBtn.disabled = false;
        if (muxBtn) muxBtn.disabled = false;
        if (status === 'complete') {
          showToast(statusLabel);
        } else if (status === 'failed') {
          if (statusLabel === 'Error: API_UNAVAILABLE') {
            const item = mediaItems.find(m => m.id === itemId);
            if (item) {
              const cmd = `yt-dlp "${item.url}" -o "${getSmartName(item)}"`;
              navigator.clipboard.writeText(cmd).catch(() => { });
              showToast('YouTube API failed. yt-dlp command copied!');
            }
          } else {
            showToast(statusLabel);
          }
        } else if (status === 'cancelled') {
          showToast('Download cancelled');
        }
      } else {
        if (progressEl) progressEl.classList.add('active');
        if (dlBtn) dlBtn.disabled = true;
        if (muxBtn) muxBtn.disabled = true;
        if (fillEl) fillEl.style.width = `${percent}%`;
        if (percentEl) percentEl.textContent = `${percent}%`;
        if (statusEl) statusEl.textContent = (statusLabel || 'Downloading...') + (speedLabel ? ' · ' + speedLabel : '');
      }
    }
  });

  await loadMedia();

  // Actively trigger on-demand scan across all frames
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { type: 'SCAN_MEDIA_NOW' }, () => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: currentTabId, allFrames: true },
          files: ['content/content.js']
        }).catch(() => {});
        chrome.scripting.executeScript({
          target: { tabId: currentTabId, allFrames: true },
          files: ['content/inject.js'],
          world: 'MAIN'
        }).then(() => {
          setTimeout(() => {
            chrome.tabs.sendMessage(currentTabId, { type: 'SCAN_MEDIA_NOW' }).catch(() => {});
          }, 100);
        }).catch(() => {});
      }
    });
    setTimeout(loadMedia, 300);
    setTimeout(loadMedia, 800);
    setTimeout(loadMedia, 1500);
  }

  // Fetch page thumbnail
  if (currentTabId) {
    chrome.runtime.sendMessage({ type: 'GET_THUMBNAIL', tabId: currentTabId }, (resp) => {
      if (resp?.thumbnail) pageThumbnail = resp.thumbnail;
    });
  }

  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
  });

  // Advanced features toggle handling
  const advancedToggle = document.getElementById('advancedToggle');

  // Initialize toggle state based on stored preference and permissions
  chrome.storage.local.get({ advancedEnabled: false }, async (data) => {
    const hasPerm = await chrome.permissions.contains({ permissions: ['nativeMessaging', 'tabs'] });
    if (hasPerm) {
      if (!data.advancedEnabled) {
        chrome.storage.local.set({ advancedEnabled: true });
      }
      advancedToggle.checked = true;
    } else {
      if (data.advancedEnabled) {
        chrome.storage.local.set({ advancedEnabled: false });
      }
      advancedToggle.checked = false;
    }
    updateAdvancedUIState();
  });

  // Handle toggle changes
  advancedToggle.addEventListener('change', async () => {
    if (advancedToggle.checked) {
      const granted = await chrome.permissions.request({
        permissions: ['nativeMessaging', 'tabs']
      });
      if (granted) {
        chrome.storage.local.set({ advancedEnabled: true });
      } else {
        advancedToggle.checked = false;
        chrome.storage.local.set({ advancedEnabled: false });
      }
    } else {
      await chrome.permissions.remove({ permissions: ['nativeMessaging', 'tabs'] });
      chrome.storage.local.set({ advancedEnabled: false });
    }
    updateAdvancedUIState();
  });

  // Update UI based on permissions and native host availability
  async function updateAdvancedUIState() {
    const permGranted = await chrome.permissions.contains({ permissions: ['nativeMessaging', 'tabs'] });
    let nativeHostAvailable = false;
    if (permGranted) {
      try {
        const port = chrome.runtime.connectNative('net.mediasniff.coapp');
        port.onDisconnect.addListener(() => {
          // native host not available
        });
        nativeHostAvailable = true;
        port.disconnect();
      } catch (e) {
        nativeHostAvailable = false;
      }
    }
    console.log('Advanced features:', { permGranted, nativeHostAvailable });
  }

  clearBtn?.addEventListener('click', async () => {
    if (currentTabId) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA', tabId: currentTabId });
      mediaItems = [];
      renderMediaList();
      showToast('Cleared all detected media');
    }
  });

  scanBtn?.addEventListener('click', () => {
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { type: 'SCAN_MEDIA_NOW' }).catch(() => {});
      showToast('Scanning for media...');
      setTimeout(loadMedia, 500);
    }
  });
});

// ─── Load Media from Background ─────────────────────────────────────
async function loadMedia() {
  if (!currentTabId) return;
  try {
    const [mediaResp, activeDlResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_MEDIA', tabId: currentTabId }).catch(() => null),
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_DOWNLOADS' }).catch(() => null)
    ]);
    if (activeDlResp?.downloads) {
      for (const dl of activeDlResp.downloads) {
        activeDownloads.set(dl.itemId, dl);
        activeDownloads.set(String(dl.itemId), dl);
      }
    }
    mediaItems = mediaResp?.media || [];
    renderMediaList();
  } catch (e) {
    console.warn('[MediaSniff] Failed to load media from background:', e);
  }
}

function restoreDownloadUI(dl) {
  const itemId = dl.itemId;
  const progressEl = document.getElementById(`progress-${itemId}`);
  const fillEl = document.getElementById(`progressFill-${itemId}`);
  const statusEl = document.getElementById(`progressStatus-${itemId}`);
  const percentEl = document.getElementById(`progressPercent-${itemId}`);
  const dlBtn = document.getElementById(`dl-${itemId}`);
  const muxBtn = document.getElementById(`mux-${itemId}`);

  if (progressEl) {
    progressEl.classList.add('active');
    if (dlBtn) dlBtn.disabled = true;
    if (muxBtn) muxBtn.disabled = true;
    if (fillEl) fillEl.style.width = `${dl.percent}%`;
    if (percentEl) percentEl.textContent = `${dl.percent}%`;
    if (statusEl) statusEl.textContent = (dl.statusLabel || 'Downloading...') + (dl.speedLabel ? ' · ' + dl.speedLabel : '');
  }
}

// ─── Render ─────────────────────────────────────────────────────────
function renderMediaList() {
  // Apply minSizeFilter
  const filteredItems = mediaItems.filter(item => {
    if (currentMinSize > 0 && item.size && item.size < currentMinSize) return false;
    return true;
  });

  const count = filteredItems.length;
  headerSubtitle.textContent = count > 0
    ? `${count} media item${count !== 1 ? 's' : ''} detected`
    : 'Scanning for media...';

  if (count === 0 && activeDownloads.size === 0) {
    mediaListEl.innerHTML = '';
    emptyStateEl.classList.add('visible');
    return;
  }

  emptyStateEl.classList.remove('visible');

  // Sort: streams first, then by size/timestamp
  const sorted = [...filteredItems].sort((a, b) => {
    const typeOrder = { stream: 0, video: 1, audio: 2, subtitle: 3 };
    const ta = typeOrder[a.type] ?? 9;
    const tb = typeOrder[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    return b.timestamp - a.timestamp;
  });

  const currentItemCardIds = new Set();

  for (const item of sorted) {
    const cardId = `card-${item.id}`;
    currentItemCardIds.add(cardId);
    let card = document.getElementById(cardId);

    if (card) {
      const prevParsed = card.dataset.parsed;
      const prevVariants = card.dataset.variants;
      if (prevParsed !== String(item.parsed) || prevVariants !== String(item.variants?.length || 0)) {
        const newCard = createMediaCard(item);
        card.replaceWith(newCard);
        card = newCard;
      } else {
        if (card.parentElement !== mediaListEl) {
          mediaListEl.appendChild(card);
        }
        updateMediaCard(card, item);
      }
    } else {
      card = createMediaCard(item);
      mediaListEl.appendChild(card);
    }

    // Ensure active download state is applied to this card
    const activeDl = activeDownloads.get(item.id) || activeDownloads.get(String(item.id));
    if (activeDl) {
      restoreDownloadUI(activeDl);
    }
  }

  // Remove cards that no longer exist (unless they have an active download)
  for (const child of Array.from(mediaListEl.children)) {
    if (child.id && child.id.startsWith('card-') && !currentItemCardIds.has(child.id)) {
      const rawId = child.id.replace('card-', '');
      const hasActive = activeDownloads.has(rawId) || activeDownloads.has(parseInt(rawId));
      if (!hasActive) {
        child.remove();
      }
    }
  }
}

function updateMediaCard(card, item) {
  // Update segment count badge if changed
  let segBadge = card.querySelector('.badge.segments');
  if (item.segmentCount > 0) {
    const text = `${item.segmentCount} segs`;
    if (segBadge) {
      if (segBadge.textContent !== text) {
        segBadge.textContent = text;
      }
    } else {
      const badgesContainer = card.querySelector('.card-badges');
      if (badgesContainer) {
        const span = document.createElement('span');
        span.className = 'badge segments';
        span.textContent = text;
        badgesContainer.appendChild(span);
      }
    }
  }
  // Update size badge if available
  if (item.sizeLabel && item.sizeLabel !== 'Unknown') {
    let sizeBadge = card.querySelector('.badge.size');
    if (sizeBadge && sizeBadge.textContent !== item.sizeLabel) {
      sizeBadge.textContent = item.sizeLabel;
    }
  }
}

// ─── Create Card ────────────────────────────────────────────────────
function createMediaCard(item) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.id = `card-${item.id}`;
  card.dataset.parsed = String(item.parsed);
  card.dataset.variants = String(item.variants?.length || 0);

  const smartName = getSmartName(item);
  const iconClass = item.type === 'audio' ? 'audio' : item.type === 'subtitle' ? 'subtitle' : '';
  const iconSvg = ICONS[item.type] || ICONS.video;

  const isDrm = !!(item.isEncrypted || item.isProtected);
  const lockIcon = isDrm ? '🔒 ' : '';

  let html = `
    <div class="card-header">
      ${item.thumbnail || pageThumbnail ? `
        <div class="card-thumb">
          <img src="${escHtml(item.thumbnail || pageThumbnail)}" alt="" loading="lazy" onerror="if(this.src.includes('maxresdefault')){this.src=this.src.replace('maxresdefault','hqdefault')}else{this.style.display='none'}">
        </div>
      ` : ''}
      <div class="media-icon ${iconClass}">${iconSvg}</div>
      <div class="card-info">
        <div class="card-filename-row" id="filename-row-${item.id}">
          <div class="card-filename" id="filename-text-${item.id}" title="${escHtml(smartName)}">${escHtml(smartName)}</div>
          <button class="rename-btn" id="rename-btn-${item.id}" title="Rename">${ICONS.rename}</button>
        </div>
        <div class="card-url" title="${escHtml(item.url)}">${escHtml(truncateUrl(item.url))}</div>
      </div>
    </div>
    <div class="card-badges">
      ${item.source === 'youtube' ? '<span class="badge youtube">YOUTUBE</span>' : `<span class="badge ${item.streamType}">${item.streamType.toUpperCase()}</span>`}
      <span class="badge ${item.type}">${item.type.toUpperCase()}</span>
      ${item.sizeLabel && item.sizeLabel !== 'Unknown' ? `<span class="badge size">${item.sizeLabel}</span>` : ''}
      ${item.totalDuration ? `<span class="badge duration">${formatDuration(item.totalDuration)}</span>` : ''}
      ${item.segmentCount > 0 ? `<span class="badge segments">${item.segmentCount} segs</span>` : ''}
      ${isDrm ? `<span class="badge drm">${lockIcon}DRM</span>` : ''}
      ${item.subtitleTracks?.length > 0 ? `<span class="badge subtitle">CC</span>` : ''}
      ${item.isLive ? `<span class="badge live">● LIVE</span>` : ''}
    </div>`;

  // Quality selector for variants (HLS/DASH)
  if (item.variants && item.variants.length >= 1) {
    html += `
    <div class="quality-section">
      <div class="quality-label">Video Quality</div>
      <select class="quality-select" id="quality-${item.id}">
        ${item.variants.map((v, i) => `<option value="${i}">${v.label}${v.resolution ? ' (' + v.resolution + ')' : ''}${v.codecs ? ' [' + v.codecs + ']' : ''}</option>`).join('')}
      </select>
    </div>`;
  }

  // YouTube quality selector (uses Cobalt API)
  if (item.source === 'youtube' && item.availableQualities?.length > 0) {
    const uniqueQualities = [...new Map(item.availableQualities.map(q => [q.height, q])).values()];
    html += `
    <div class="quality-section">
      <div class="quality-label">Video Quality</div>
      <select class="quality-select" id="ytquality-${item.id}">
        ${uniqueQualities.map(q => `<option value="${q.height}">${q.label} (${q.width}x${q.height})</option>`).join('')}
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

  // Subtitle download options — auto-download subs alongside video
  if (item.subtitles && item.subtitles.length > 0) {
    html += `
    <div class="subtitle-section">
      <div class="quality-label">Subtitles</div>
      ${item.subtitles.map((sub, i) => `
        <label class="subtitle-checkbox-label">
          <input type="checkbox" id="sub-${item.id}-${i}" checked>
          📄 ${sub.language || sub.filename || 'Subtitle'} (.${sub.format || 'vtt'})
        </label>
      `).join('')}
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
      <button class="btn btn-download" id="dl-${item.id}" title="Download">
        ${ICONS.download} Download
      </button>
      ${(item.variants?.length > 0 && item.audioRenditions?.length > 0) ? `
        <button class="btn btn-mux" id="mux-${item.id}" title="Download & combine video+audio">
          ${ICONS.mux} Mux
        </button>
      ` : ''}
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
        <div style="display:flex;align-items:center;gap:6px;">
          <span id="progressPercent-${item.id}">0%</span>
          <button class="btn-cancel" id="cancel-${item.id}" title="Cancel Download">✕</button>
        </div>
      </div>
    </div>`;

  card.innerHTML = html;

  // Apply qualityPref
  const qualitySelect = card.querySelector(`#quality-${item.id}`) || card.querySelector(`#ytquality-${item.id}`);
  if (qualitySelect && currentQualityPref) {
    let targetOption = null;
    const opts = Array.from(qualitySelect.options);
    if (currentQualityPref === 'highest') {
      targetOption = opts[0];
    } else if (currentQualityPref === 'lowest') {
      targetOption = opts[opts.length - 1];
    } else {
      const targetHeight = parseInt(currentQualityPref);
      for (const opt of opts) {
        if (opt.textContent.includes(`${targetHeight}p`) || opt.text.includes(targetHeight)) {
          targetOption = opt;
          break;
        }
      }
      if (!targetOption) targetOption = opts[0];
    }
    if (targetOption) targetOption.selected = true;
  }

  // ─── Event Listeners ────────────────────────
  // Download button
  const dlBtn = card.querySelector(`#dl-${item.id}`);
  if (dlBtn) {
    if (isDrm) {
      dlBtn.disabled = true;
      dlBtn.title = 'Protected by DRM';
    } else {
      dlBtn.addEventListener('click', () => handleDownload(item));
    }
  }

  // Rename Inline
  const renameBtn = card.querySelector(`#rename-btn-${item.id}`);
  const filenameText = card.querySelector(`#filename-text-${item.id}`);
  if (renameBtn && filenameText) {
    renameBtn.addEventListener('click', () => {
      const currentName = filenameText.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentName;
      input.className = 'rename-input';
      
      const saveName = () => {
        const newName = input.value.trim() || currentName;
        item.filename = newName;
        filenameText.textContent = newName;
        filenameText.title = newName;
        input.replaceWith(filenameText);
      };
      
      input.addEventListener('blur', saveName);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
      });
      
      filenameText.replaceWith(input);
      input.focus();
      input.select();
    });
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

  // Cancel button
  card.querySelector(`#cancel-${item.id}`).addEventListener('click', () => {
    activeDownloads.delete(item.id);
    activeDownloads.delete(String(item.id));
    chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', itemId: item.id });
    const progressEl = card.querySelector(`#progress-${item.id}`);
    const dlBtn = card.querySelector(`#dl-${item.id}`);
    const muxBtn = card.querySelector(`#mux-${item.id}`);
    if (progressEl) progressEl.classList.remove('active');
    if (dlBtn) dlBtn.disabled = false;
    if (muxBtn) muxBtn.disabled = false;
    showToast('Download cancelled');
  });

  // If this item is actively downloading, restore its UI state immediately
  const initialActiveDl = activeDownloads.get(item.id) || activeDownloads.get(String(item.id));
  if (initialActiveDl) {
    const progressEl = card.querySelector(`#progress-${item.id}`);
    const fillEl = card.querySelector(`#progressFill-${item.id}`);
    const statusEl = card.querySelector(`#progressStatus-${item.id}`);
    const percentEl = card.querySelector(`#progressPercent-${item.id}`);
    const dlBtn = card.querySelector(`#dl-${item.id}`);
    const muxBtn = card.querySelector(`#mux-${item.id}`);

    if (progressEl) progressEl.classList.add('active');
    if (dlBtn) dlBtn.disabled = true;
    if (muxBtn) muxBtn.disabled = true;
    if (fillEl) fillEl.style.width = `${initialActiveDl.percent}%`;
    if (percentEl) percentEl.textContent = `${initialActiveDl.percent}%`;
    if (statusEl) statusEl.textContent = (initialActiveDl.statusLabel || 'Downloading...') + (initialActiveDl.speedLabel ? ' · ' + initialActiveDl.speedLabel : '');
  }

  return card;
}

// ─── Smart Context Naming ───────────────────────────────────────────
function getSmartName(item) {
  let name = '';

  // 1. If item has its own sniffed filename, prioritize that
  if (item.filename && item.filename !== 'Live Video Stream' && item.filename !== 'HLS Video' && item.filename !== 'DASH Video') {
    name = item.filename;
  } else if (item.title && item.title !== 'Live Video Stream' && item.title !== 'HLS Video' && item.title !== 'DASH Video') {
    name = item.title;
  } else if (pageTitle) {
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

  // For YouTube downloads, dynamically determine extension based on selected format
  if (item.source === 'youtube') {
    const ytQualitySelect = document.getElementById(`ytquality-${item.id}`);
    const ytQuality = ytQualitySelect ? parseInt(ytQualitySelect.value) : 1080;
    
    if (item.rawAdaptiveFormats && item.rawAdaptiveFormats.length > 0) {
      const webmFmt = item.rawAdaptiveFormats.find(f => f.height === ytQuality && f.mimeType?.includes('video/webm'));
      const mp4Fmt = item.rawAdaptiveFormats.find(f => f.height === ytQuality && f.mimeType?.includes('video/mp4'));
      if (webmFmt && !mp4Fmt) {
        ext = '.webm';
      }
    }
  }

  // Strip existing extension if any to avoid duplicate extensions
  name = name.replace(/\.(mp4|webm|mkv|ts|m4s|m4a|mp3|vtt|srt)$/i, '');

  // Strip duplicate trailing resolution/quality tag if already present in title
  if (quality) {
    const qualEscaped = quality.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    name = name.replace(new RegExp(`\\s*[(_-]*${qualEscaped}[)]*\\s*$`, 'i'), '');
  }

  // Clean name: replace underscores with spaces, remove illegal filesystem chars, collapse whitespace
  name = name
    .replace(/_/g, ' ')
    .replace(/&/g, 'and')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Sanitize Windows reserved names
  const reservedRegex = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reservedRegex.test(name)) {
    name = name + '_media';
  }

  const suffix = quality ? ` (${quality})` : '';
  const totalExtLen = suffix.length + ext.length;
  if (name.length + totalExtLen > 80) {
    name = name.substring(0, 80 - totalExtLen).trim();
  }

  return `${name}${suffix}${ext}`;
}

// ─── Download Handlers ──────────────────────────────────────────────
function setCardDownloadStarting(itemId, label = 'Starting download...') {
  const entry = {
    itemId,
    status: 'downloading',
    percent: 0,
    statusLabel: label,
    speedLabel: ''
  };
  activeDownloads.set(itemId, entry);
  activeDownloads.set(String(itemId), entry);

  const progressEl = document.getElementById(`progress-${itemId}`);
  const fillEl = document.getElementById(`progressFill-${itemId}`);
  const statusEl = document.getElementById(`progressStatus-${itemId}`);
  const percentEl = document.getElementById(`progressPercent-${itemId}`);
  const dlBtn = document.getElementById(`dl-${itemId}`);
  const muxBtn = document.getElementById(`mux-${itemId}`);

  if (progressEl) progressEl.classList.add('active');
  if (dlBtn) dlBtn.disabled = true;
  if (muxBtn) muxBtn.disabled = true;
  if (fillEl) fillEl.style.width = '0%';
  if (percentEl) percentEl.textContent = '0%';
  if (statusEl) statusEl.textContent = label;
}

async function handleDownload(item) {
  if (item.isEncrypted) {
    showToast('Cannot download DRM-protected content');
    return;
  }

  // YouTube videos — use background YouTube downloader
  if (item.source === 'youtube') {
    await handleYouTubeDownload(item);
    return;
  }

  if (item.streamType === 'direct') {
    // Direct download
    const filename = getSmartName(item);
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT', url: getSelectedUrl(item), filename });
    showToast('Download started');
    return;
  }

  // If HLS/DASH stream has separate audio renditions, we MUST mux it to get audio!
  if (item.audioRenditions && item.audioRenditions.length > 0 && item.audioRenditions.some(a => a.url)) {
    const qualitySelect = document.getElementById(`quality-${item.id}`);
    const qualityIndex = qualitySelect ? parseInt(qualitySelect.value) : 0;
    const variant = item.variants?.[qualityIndex];
    const height = variant?.height;
    if (item.directMp4Urls && height && item.directMp4Urls[height]) {
      const filename = getSmartName(item);
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT', url: item.directMp4Urls[height], filename });
      showToast('Downloading direct MP4...');
      return;
    }
    await handleMuxDownload(item);
    return;
  }

  // Streaming download — delegate to background
  const qualitySelect = document.getElementById(`quality-${item.id}`);
  const qualityIndex = qualitySelect ? parseInt(qualitySelect.value) : 0;
  const filename = getSmartName(item);

  downloadSubtitles(item, filename);

  setCardDownloadStarting(item.id, 'Starting stream download...');

  chrome.runtime.sendMessage({
    type: 'START_DOWNLOAD',
    itemId: item.id,
    item,
    downloadType: 'stream',
    options: { filename, qualityIndex }
  });
}

async function handleYouTubeDownload(item) {
  const ytQualitySelect = document.getElementById(`ytquality-${item.id}`);
  const ytQuality = ytQualitySelect ? ytQualitySelect.value : '1080';
  const filename = getSmartName(item);
  downloadSubtitles(item, filename);
  setCardDownloadStarting(item.id, 'Starting YouTube download...');

  chrome.runtime.sendMessage({
    type: 'START_DOWNLOAD',
    itemId: item.id,
    item,
    downloadType: 'youtube',
    options: { filename, ytQuality }
  });
}

async function handleMuxDownload(item) {
  if (item.isEncrypted) {
    showToast('Cannot download DRM-protected content');
    return;
  }

  const qualitySelect = document.getElementById(`quality-${item.id}`);
  const audioSelect = document.getElementById(`audio-${item.id}`);
  const embedSubCheckbox = document.getElementById(`embedSub-${item.id}`);

  const qualityIndex = qualitySelect ? parseInt(qualitySelect.value) : 0;
  const audioIndex = audioSelect ? parseInt(audioSelect.value) : 0;
  const filename = getSmartName(item);

  downloadSubtitles(item, filename);

  setCardDownloadStarting(item.id, 'Starting mux download...');

  chrome.runtime.sendMessage({
    type: 'START_DOWNLOAD',
    itemId: item.id,
    item,
    downloadType: 'mux',
    options: { filename, qualityIndex, audioIndex }
  });
}

// ─── Subtitle Auto-Downloader ───────────────────────────────────────
async function downloadSubtitles(item, videoFilename) {
  if (!item.subtitles || item.subtitles.length === 0) return;

  const baseName = videoFilename.replace(/\.[^.]+$/, ''); // strip extension

  for (let i = 0; i < item.subtitles.length; i++) {
    const checkbox = document.getElementById(`sub-${item.id}-${i}`);
    if (!checkbox || !checkbox.checked) continue;

    const sub = item.subtitles[i];
    try {
      let subBlob;
      let ext = sub.format || 'vtt';

      if (sub.url.includes('.m3u8')) {
        // Fetch segmented VTT
        const m3u8Resp = await fetch(sub.url);
        if (!m3u8Resp.ok) continue;
        const text = await m3u8Resp.text();
        const lines = text.split(/\r?\n/);
        const segmentUrls = [];
        let baseUrl = sub.url.substring(0, sub.url.lastIndexOf('/') + 1);
        for (const line of lines) {
          if (line && !line.startsWith('#')) {
            segmentUrls.push(line.startsWith('http') ? line : baseUrl + line);
          }
        }
        
        let fullVtt = 'WEBVTT\n\n';
        for (const segUrl of segmentUrls) {
          const segResp = await fetch(segUrl);
          if (!segResp.ok) continue;
          let segText = await segResp.text();
          // Remove WEBVTT header and X-TIMESTAMP-MAP
          segText = segText.replace(/^WEBVTT.*[\r\n]*/i, '');
          segText = segText.replace(/^X-TIMESTAMP-MAP.*[\r\n]*/im, '');
          fullVtt += segText.trim() + '\n\n';
        }
        subBlob = new Blob([fullVtt], { type: 'text/vtt' });
        ext = 'vtt';
      } else {
        const response = await fetch(sub.url);
        if (!response.ok) continue;
        subBlob = await response.blob();
      }

      const lang = sub.language || `sub${i + 1}`;
      const subFilename = `${baseName}.${lang}.${ext}`;
      triggerBlobDownload(subBlob, subFilename);
    } catch (e) {
      console.warn(`[MediaSniff] Subtitle download failed:`, e.message);
    }
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
  const reader = new FileReader();
  reader.onload = () => {
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_BLOB',
      dataUrl: reader.result,
      filename: sanitizeFilename(filename)
    }).catch(() => {});
  };
  reader.readAsDataURL(blob);
}

function sanitizeFilename(name) {
  if (!name) return 'download.mp4';
  return name
    .replace(/_/g, ' ')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\.\./g, ' ')
    .replace(/^\.+/, '')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200) || 'download.mp4';
}