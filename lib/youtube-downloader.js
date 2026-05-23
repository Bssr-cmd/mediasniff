/**
 * MediaSniff — YouTube Downloader
 * Uses Invidious API instances to get direct YouTube video URLs.
 * Invidious is open-source and provides reliable direct video links.
 */

export class YouTubeDownloader {
  // Working Invidious API instances
  static INVIDIOUS_INSTANCES = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://invidious.jing.rocks',
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
   * Get direct download URL for a YouTube video.
   * @param {string} videoUrl - YouTube watch URL
   * @param {string} quality - Desired height (e.g. '1080', '720')
   * @returns {Promise<{url: string, filename: string, audioUrl?: string}|null>}
   */
  static async getDownloadUrl(videoUrl, quality = '1080') {
    const videoId = this._extractVideoId(videoUrl);
    if (!videoId) return null;

    // Strategy 1: Try Invidious API
    for (const instance of this.INVIDIOUS_INSTANCES) {
      try {
        const result = await this._tryInvidious(instance, videoId, parseInt(quality));
        if (result) return result;
      } catch (e) {
        console.warn(`[MediaSniff] Invidious ${instance} failed:`, e.message);
      }
    }

    // Strategy 2: Try Piped API
    for (const instance of this.PIPED_INSTANCES) {
      try {
        const result = await this._tryPiped(instance, videoId, parseInt(quality));
        if (result) return result;
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
      const resp = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Get adaptive formats (separate video/audio)
      const adaptiveFormats = data.adaptiveFormats || [];
      const videoStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('video/') && f.url)
        .sort((a, b) => (b.resolution ? parseInt(b.resolution) : 0) - (a.resolution ? parseInt(a.resolution) : 0));

      const audioStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('audio/') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      // Find best matching video stream
      let videoStream = videoStreams.find(f => {
        const h = parseInt(f.resolution) || f.qualityLabel?.match(/(\d+)p/)?.[1];
        return h && h <= targetHeight;
      }) || videoStreams[0];

      // Also try combined format streams (video+audio in one)
      const formatStreams = data.formatStreams || [];
      const combinedStream = formatStreams
        .filter(f => f.url)
        .sort((a, b) => {
          const ha = parseInt(a.resolution) || 0;
          const hb = parseInt(b.resolution) || 0;
          return hb - ha;
        })
        .find(f => {
          const h = parseInt(f.resolution) || 0;
          return h <= targetHeight;
        }) || formatStreams[0];

      // Prefer combined stream (has audio+video together)
      if (combinedStream?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: combinedStream.url,
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: combinedStream.qualityLabel || combinedStream.resolution || 'Unknown',
          isCombined: true,
        };
      }

      // Fall back to adaptive (video only — need separate audio)
      if (videoStream?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: videoStream.url,
          audioUrl: audioStreams[0]?.url || null,
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: videoStream.qualityLabel || videoStream.resolution || 'Unknown',
          isCombined: false,
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
  static async downloadStream(downloadUrl, onProgress, signal) {
    const response = await fetch(downloadUrl, { signal });
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
