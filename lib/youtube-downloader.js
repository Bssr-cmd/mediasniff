/**
 * MediaSniff — YouTube Downloader
 * 
 * Features:
 * 1. Direct YouTube watch page scraping.
 * 2. Static signature deciphering interpreter (MV3 CSP compliant, eval-free).
 * 3. Fallback proxy resolution via dynamic Invidious and Piped APIs.
 */

function parseCipher(cipherStr) {
  const params = {};
  const parts = cipherStr.split('&');
  for (const part of parts) {
    const equalIdx = part.indexOf('=');
    if (equalIdx > 0) {
      const key = decodeURIComponent(part.substring(0, equalIdx));
      const val = decodeURIComponent(part.substring(equalIdx + 1));
      params[key] = val;
    }
  }
  return {
    url: params.url,
    s: params.s,
    sp: params.sp || 'sig'
  };
}

export class YouTubeDownloader {
  // Fallback Invidious API instances in case tracker is offline
  static INVIDIOUS_INSTANCES = [
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

  static _decipherCache = null;

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
   * Directly scrape YouTube watch page and retrieve player config & JS assets
   */
  static async getDirectStreams(videoId) {
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`;
      console.log(`[YouTubeDownloader] Scrape request: ${url}`);
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      
      // 1. Extract ytInitialPlayerResponse JSON
      const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|script)/) 
        || html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/)
        || html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
      
      if (!playerResponseMatch) {
        throw new Error('ytInitialPlayerResponse not found in page source');
      }
      
      const playerResponse = JSON.parse(playerResponseMatch[1]);
      const streamingData = playerResponse.streamingData;
      const videoDetails = playerResponse.videoDetails;
      
      if (!streamingData) {
        throw new Error('No streamingData found in player response');
      }
      
      // 2. Extract player JS asset URL
      const assetsMatch = html.match(/"jsUrl"\s*:\s*"([^"]+)"/)
        || html.match(/href="([^"]+base\.js)"/)
        || html.match(/"assets"\s*:\s*\{\s*"js"\s*:\s*"([^"]+)"/)
        || html.match(/\/s\/player\/[a-zA-Z0-9_-]+\/player_ias\.vflset\/[a-zA-Z0-9_/-]+\/base\.js/);
      
      let jsUrl = null;
      if (assetsMatch) {
        jsUrl = assetsMatch[1] || assetsMatch[0];
        if (jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
        else if (jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;
      }
      
      return { playerResponse, jsUrl };
    } catch (e) {
      console.warn('[YouTubeDownloader] Scrape failed:', e.message);
      return null;
    }
  }

  /**
   * Parses base.js to dynamically rebuild the decipher function without eval/new Function
   */
  static async getDecipherFunction(jsUrl) {
    if (this._decipherCache && this._decipherCache.jsUrl === jsUrl) {
      return this._decipherCache.decipher;
    }
    
    if (!jsUrl) return null;
    
    try {
      console.log('[YouTubeDownloader] Fetching player JS asset:', jsUrl);
      const resp = await fetch(jsUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const js = await resp.text();
      
      // 1. Locate the main decipher function (split("") -> ops -> join(""))
      const funcMatch = js.match(/([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\(\"\"\);\s*([^\}]+)\s*return\s+\2\.join\(\"\"\)\s*\}/);
      if (!funcMatch) {
        throw new Error('Main decipher function pattern not found in player JS');
      }
      
      const funcName = funcMatch[1];
      const argName = funcMatch[2];
      const funcBody = funcMatch[3];
      
      // 2. Parse instruction sequences
      const stmtRegex = /([a-zA-Z0-9$_]+)\.([a-zA-Z0-9$_]+)\(\s*[a-zA-Z0-9$_]+\s*,\s*(\d+)\s*\)/g;
      let stmtMatch;
      const instructions = [];
      let helperName = null;
      
      while ((stmtMatch = stmtRegex.exec(funcBody)) !== null) {
        helperName = stmtMatch[1];
        instructions.push({
          methodName: stmtMatch[2],
          param: parseInt(stmtMatch[3])
        });
      }
      
      if (!helperName || instructions.length === 0) {
        throw new Error('Could not parse decipher instructions');
      }
      
      // 3. Extract the helper object definition
      const helperEscaped = helperName.replace(/[$]/g, '\\$');
      const helperRegex = new RegExp(`(?:var\\s+|\\b)${helperEscaped}\\s*=\\s*\\{([\\s\\S]+?)\\};`);
      const helperMatch = js.match(helperRegex);
      
      if (!helperMatch) {
        throw new Error(`Helper object ${helperName} definition not found`);
      }
      
      const helperBody = helperMatch[1];
      
      // 4. Map helper method actions to operations
      const methodRegex = /([a-zA-Z0-9$_]+)\s*:\s*function\s*\(([^)]*)\)\s*\{([^}]+)\}/g;
      let methodMatch;
      const methodsMap = Object.create(null);
      
      while ((methodMatch = methodRegex.exec(helperBody)) !== null) {
        const name = methodMatch[1];
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
        const body = methodMatch[3];
        
        if (body.includes('.reverse')) {
          methodsMap[name] = 'reverse';
        } else if (body.includes('.splice') || body.includes('.slice')) {
          methodsMap[name] = 'slice';
        } else {
          methodsMap[name] = 'swap';
        }
      }
      
      // 5. Build isolated declarable decipherer closure
      const decipher = (sig) => {
        let arr = sig.split('');
        for (const inst of instructions) {
          const op = methodsMap[inst.methodName];
          const val = inst.param;
          if (!op) continue;
          
          if (op === 'reverse') {
            arr.reverse();
          } else if (op === 'slice') {
            arr.splice(0, val);
          } else if (op === 'swap') {
            const tmp = arr[0];
            arr[0] = arr[val % arr.length];
            arr[val % arr.length] = tmp;
          }
        }
        return arr.join('');
      };
      
      this._decipherCache = { jsUrl, decipher };
      console.log('[YouTubeDownloader] Decipher algorithm extracted successfully!');
      return decipher;
    } catch (e) {
      console.error('[YouTubeDownloader] Signature extraction failed:', e.message);
      return null;
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

    // ─── Pipeline 1: Native Direct Scrape + Signature Deciphering ───
    try {
      console.log(`[YouTubeDownloader] Decipher pipeline starting for ID: ${videoId}`);
      const direct = await this.getDirectStreams(videoId);
      
      if (direct && direct.playerResponse) {
        const streamingData = direct.playerResponse.streamingData;
        const videoDetails = direct.playerResponse.videoDetails;
        
        const adaptiveFormats = streamingData.adaptiveFormats || [];
        const formats = streamingData.formats || [];
        
        const hasCipher = adaptiveFormats.some(f => f.signatureCipher || f.cipher)
          || formats.some(f => f.signatureCipher || f.cipher);
        
        let decipher = null;
        if (hasCipher && direct.jsUrl) {
          decipher = await this.getDecipherFunction(direct.jsUrl);
        }
        
        const resolveStreamUrl = (fmt) => {
          if (fmt.url) return fmt.url;
          const cipherStr = fmt.signatureCipher || fmt.cipher;
          if (!cipherStr) return null;
          
          const parsed = parseCipher(cipherStr);
          if (!parsed.url) return null;
          
          if (parsed.s && decipher) {
            const signature = decipher(parsed.s);
            const urlObj = new URL(parsed.url);
            urlObj.searchParams.set(parsed.sp, signature);
            urlObj.searchParams.set('ratebypass', 'yes'); // prevent YouTube playback throttle
            return urlObj.href;
          }
          return parsed.url;
        };

        // Extract Video Streams
        const videoStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('video/'))
          .map(f => ({ ...f, resolvedUrl: resolveStreamUrl(f) }))
          .filter(f => f.resolvedUrl)
          .sort((a, b) => (b.height || 0) - (a.height || 0));

        // Extract Audio Streams  
        const audioStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('audio/'))
          .map(f => ({ ...f, resolvedUrl: resolveStreamUrl(f) }))
          .filter(f => f.resolvedUrl)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        const targetHeight = parseInt(quality) || 1080;
        let bestVideo = videoStreams.find(f => (f.height || 0) <= targetHeight) || videoStreams[0];

        if (bestVideo) {
          const title = videoDetails.title || 'YouTube Video';
          const author = videoDetails.author || '';
          const filename = author ? `${author} - ${title}.mp4` : `${title}.mp4`;
          
          console.log(`[YouTubeDownloader] Successfully resolved direct deciphered stream: ${bestVideo.qualityLabel || bestVideo.height + 'p'}`);
          return {
            url: bestVideo.resolvedUrl,
            audioUrl: audioStreams[0]?.resolvedUrl || null,
            filename: filename,
            quality: bestVideo.qualityLabel || `${bestVideo.height}p`,
            isCombined: false
          };
        }
      }
    } catch (e) {
      console.warn('[YouTubeDownloader] Native deciphering pipeline failed, falling back:', e.message);
    }

    // ─── Pipeline 2: Fallback Invidious API with Local proxying ───
    const dynamicInstances = await this.fetchActiveInstances();
    const instancesToTry = [...new Set([...dynamicInstances, ...this.INVIDIOUS_INSTANCES])];
    console.log(`[MediaSniff] Attempting stream resolution via ${instancesToTry.length} Invidious instances`);

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

    // ─── Pipeline 3: Fallback Piped API ───
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
    } catch { }
    const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  static async _tryInvidious(instance, videoId, targetHeight) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(`${instance}/api/v1/videos/${videoId}?local=true`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const adaptiveFormats = data.adaptiveFormats || [];
      const videoStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('video/') && f.url)
        .sort((a, b) => (b.resolution ? parseInt(b.resolution) : 0) - (a.resolution ? parseInt(a.resolution) : 0));
      const audioStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('audio/') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      let videoStream = videoStreams.find(f => {
        const h = parseInt(f.resolution) || f.qualityLabel?.match(/(\d+)p/)?.[1];
        return h && h <= targetHeight;
      }) || videoStreams[0];

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

      const resolveUrl = (urlStr) => {
        if (!urlStr) return null;
        if (urlStr.startsWith('/')) {
          return `${instance}${urlStr}`;
        }
        return urlStr;
      };

      if (combinedStream?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: resolveUrl(combinedStream.url),
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: combinedStream.qualityLabel || combinedStream.resolution || 'Unknown',
          isCombined: true,
        };
      }

      if (videoStream?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: resolveUrl(videoStream.url),
          audioUrl: resolveUrl(audioStreams[0]?.url) || null,
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
