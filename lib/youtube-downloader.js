/**
 * MediaSniff — YouTube Downloader
 * Uses Invidious API instances to get direct YouTube video URLs.
 * Invidious is open-source and provides reliable direct video links.
 */

export class YouTubeDownloader {
  // Fallback Invidious API instances in case tracker is offline
  static INVIDIOUS_INSTANCES = [
    'https://inv.thepixora.com',
    'https://invidious.jing.rocks',
    'https://invidious.nerdvpn.de',
    'https://invidious.lunar.icu',
    'https://yewtu.be',
    'https://invidious.projectsegfaut.de',
    'https://inv.nadeko.net',
    'https://vid.puffyan.us',
    'https://invidious.privacyredirect.com',
    'https://iv.nbooo.com',
  ];

  // Piped API instances (alternative)
  static PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.privacydev.net',
  ];

  /**
   * Dynamically fetch healthy Invidious instances from the official tracker
   */
  static async fetchActiveInstances() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      
      const resp = await fetch('https://api.invidious.io/instances.json?sort_by=type,api,users', {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeout);
      
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const instances = await resp.json();
      
      const working = [];
      for (const [domain, info] of instances) {
        if (info.type === 'https' && info.monitor && info.monitor.down === false) {
          working.push({
            uri: info.uri || `https://${domain}`,
            uptime: info.monitor.uptime || 0
          });
        }
      }
      
      // Sort by uptime descending
      working.sort((a, b) => b.uptime - a.uptime);
      return working.map(w => w.uri);
    } catch (e) {
      console.warn('[MediaSniff] Failed to fetch dynamic Invidious instances, using fallbacks:', e.message);
      return [];
    }
  }

  /**
   * Get direct download URL for a YouTube video.
   * @param {string} videoUrl - YouTube watch URL
   * @param {string} quality - Desired height (e.g. '1080', '720')
   * @returns {Promise<{url: string, filename: string, audioUrl?: string, isCombined: boolean}|null>}
   */
  static async getDownloadUrl(videoUrl, quality = '1080') {
    const videoId = this._extractVideoId(videoUrl);
    if (!videoId) return null;

    // Fetch dynamic working instances
    const dynamicInstances = await this.fetchActiveInstances();
    
    // Combine dynamic list with static fallback list
    const instancesToTry = [...new Set([...dynamicInstances, ...this.INVIDIOUS_INSTANCES])];
    console.log(`[MediaSniff] Attempting stream resolution via ${instancesToTry.length} Invidious instances:`, instancesToTry);

    // Strategy 1: Try Invidious API with local proxying
    for (const instance of instancesToTry) {
      try {
        console.log(`[MediaSniff] Querying Invidious instance: ${instance}`);
        const result = await this._tryInvidious(instance, videoId, parseInt(quality));
        if (result) {
          console.log(`[MediaSniff] Successfully resolved stream from: ${instance}`);
          return result;
        }
      } catch (e) {
        console.warn(`[MediaSniff] Invidious ${instance} failed:`, e.message);
      }
    }

    // Strategy 2: Try Piped API
    for (const instance of this.PIPED_INSTANCES) {
      try {
        console.log(`[MediaSniff] Querying Piped instance: ${instance}`);
        const result = await this._tryPiped(instance, videoId, parseInt(quality));
        if (result) {
          console.log(`[MediaSniff] Successfully resolved stream from Piped: ${instance}`);
          return result;
        }
      } catch (e) {
        console.warn(`[MediaSniff] Piped ${instance} failed:`, e.message);
      }
    }

    return null;
  }

  static _extractVideoId(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtube.com')) {
        return u.searchParams.get('v');
      }
      if (u.hostname === 'youtu.be') {
        return u.pathname.slice(1);
      }
    } catch {}
    // Try regex fallback
    const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  static async _tryInvidious(instance, videoId, targetHeight) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      // Query with local=true to instruct Invidious to proxy the googlevideo stream and bypass blocks.
      // If the instance has local proxying disabled (which is common due to bandwidth limits), fallback to query without it.
      let resp;
      try {
        console.log(`[MediaSniff] Trying Invidious ${instance} with local=true...`);
        resp = await fetch(`${instance}/api/v1/videos/${videoId}?local=true`, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      } catch (e) {
        console.warn(`[MediaSniff] local=true failed on ${instance}, falling back to direct metadata query:`, e.message);
        resp = await fetch(`${instance}/api/v1/videos/${videoId}`, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' },
        });
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Get adaptive formats (separate video/audio)
      const adaptiveFormats = data.adaptiveFormats || [];

      // Helper to extract height/resolution with 100% precision
      const getHeight = (f) => {
        if (f.height) return parseInt(f.height);
        if (f.resolution) {
          const parts = String(f.resolution).split('x');
          return parts.length > 1 ? parseInt(parts[1]) : parseInt(parts[0]);
        }
        if (f.qualityLabel) {
          const match = f.qualityLabel.match(/(\d+)p/);
          if (match) return parseInt(match[1]);
        }
        return 0;
      };

      const isAVC = (f) => {
        const type = String(f.type || f.mimeType || '').toLowerCase();
        const codec = String(f.codec || f.codecs || '').toLowerCase();
        return type.includes('avc1') || type.includes('h264') || type.includes('avc') ||
               codec.includes('avc1') || codec.includes('h264') || codec.includes('avc');
      };

      const videoStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('video/') && f.url)
        .sort((a, b) => {
          const hDiff = getHeight(b) - getHeight(a);
          if (hDiff !== 0) return hDiff;
          
          // Force AVC/H.264 to the top for same-resolution streams for perfect playability on Windows
          const aIsAVC = isAVC(a);
          const bIsAVC = isAVC(b);
          if (aIsAVC && !bIsAVC) return -1;
          if (!aIsAVC && bIsAVC) return 1;
          
          // Prefer MP4 (H.264) over WebM (VP9/AV1) for maximum compatibility with standard media players
          const aType = String(a.type || a.mimeType || '').toLowerCase();
          const bType = String(b.type || b.mimeType || '').toLowerCase();
          const aIsMp4 = aType.includes('mp4');
          const bIsMp4 = bType.includes('mp4');
          if (aIsMp4 && !bIsMp4) return -1;
          if (!aIsMp4 && bIsMp4) return 1;
          return 0;
        });

      const audioStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('audio/') && f.url)
        .sort((a, b) => {
          // Prefer MP4/M4A (AAC) over WebM (Opus) for maximum compatibility
          const aType = String(a.type || a.mimeType || '').toLowerCase();
          const bType = String(b.type || b.mimeType || '').toLowerCase();
          const aIsMp4 = aType.includes('mp4') || aType.includes('m4a');
          const bIsMp4 = bType.includes('mp4') || bType.includes('m4a');
          if (aIsMp4 && !bIsMp4) return -1;
          if (!aIsMp4 && bIsMp4) return 1;
          
          return (b.bitrate || 0) - (a.bitrate || 0);
        });

      // Find best matching video stream
      let videoStream = videoStreams.find(f => {
        const h = getHeight(f);
        return h && h <= targetHeight;
      }) || videoStreams[0];

      // Also try combined format streams (video+audio in one)
      const formatStreams = data.formatStreams || [];
      const combinedStream = formatStreams
        .filter(f => f.url)
        .sort((a, b) => getHeight(b) - getHeight(a))
        .find(f => {
          const h = getHeight(f);
          return h && h <= targetHeight;
        }) || formatStreams[0];

      // Helper to resolve relative proxy URLs against the instance domain
      const resolveUrl = (urlStr) => {
        if (!urlStr) return null;
        let resolved = urlStr;
        if (urlStr.startsWith('/')) {
          resolved = `${instance}${urlStr}`;
        }
        // Force HTTPS if the instance itself is HTTPS to prevent Mixed Content blocking in extension context
        if (instance.startsWith('https://') && resolved.startsWith('http://')) {
          resolved = resolved.replace('http://', 'https://');
        }
        return resolved;
      };

      const vHeight = videoStream ? getHeight(videoStream) : 0;
      const cHeight = combinedStream ? getHeight(combinedStream) : 0;

      // Use combined stream ONLY if its resolution is equal to or better than the separate adaptive stream,
      // OR if no separate adaptive stream is found.
      if (combinedStream?.url && (cHeight >= vHeight || !videoStream)) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: resolveUrl(combinedStream.url),
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: combinedStream.qualityLabel || combinedStream.resolution || 'Unknown',
          isCombined: true,
        };
      }

      // Otherwise, use the higher-quality adaptive video stream + separate audio track
      if (videoStream?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: resolveUrl(videoStream.url),
          audioUrl: resolveUrl(audioStreams[0]?.url) || null,
          combinedUrl: resolveUrl(combinedStream?.url) || null,
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: videoStream.qualityLabel || videoStream.resolution || 'Unknown',
          isCombined: false,
          videoType: videoStream.type || videoStream.mimeType || '',
          audioType: audioStreams[0]?.type || audioStreams[0]?.mimeType || '',
        };
      }

      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  static async _tryPiped(instance, videoId, targetHeight) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const resp = await fetch(`${instance}/streams/${videoId}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const videoStreams = (data.videoStreams || [])
        .filter(s => s.url && s.videoOnly === false)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      // Find best match
      let stream = videoStreams.find(s => (s.height || 0) <= targetHeight) || videoStreams[0];

      if (stream?.url) {
        const title = data.title || 'YouTube Video';
        const uploader = data.uploader || '';
        return {
          url: stream.url,
          filename: uploader ? `${uploader} - ${title}.mp4` : `${title}.mp4`,
          quality: `${stream.height}p`,
          isCombined: true,
        };
      }

      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Download video with progress tracking.
   */
  static async downloadStream(downloadUrl, onProgress, signal, headers = null) {
    const fetchOptions = { signal };
    if (headers) {
      fetchOptions.headers = headers;
    }
    const response = await fetch(downloadUrl, fetchOptions);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

    const contentLength = parseInt(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    const startTime = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      if (onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? received / elapsed : 0;
        const percent = contentLength > 0 ? Math.round((received / contentLength) * 100) : 0;
        onProgress({
          percent: Math.min(percent, 100),
          received,
          total: contentLength,
          speed,
          speedLabel: speed > 0 ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s` : '',
          sizeLabel: `${(received / (1024 * 1024)).toFixed(1)} MB`,
        });
      }
    }

    return new Blob(chunks, { type: 'video/mp4' });
  }
}
