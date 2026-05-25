import { SegmentDownloader } from '../lib/segment-downloader.js';
import { Transmuxer } from '../lib/transmuxer.js';
import { WASMMuxer } from '../lib/muxer.js';
import { YouTubeDownloader } from '../lib/youtube-downloader.js';

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

const activeDownloads = new Map(); // itemId -> Task
class DownloadTask {
  constructor(itemId, item, downloadType, options) {
    this.itemId = itemId;
    this.item = item;
    this.downloadType = downloadType;
    this.options = options;
    this.downloader = null;
    this.abortController = new AbortController();
  }
  async start() {
    try {
      this.reportProgress(0, 'Preparing...', '');
      if (this.downloadType === 'youtube') {
        await this.downloadYouTube();
      } else if (this.downloadType === 'mux') {
        await this.downloadMux();
      } else if (this.downloadType === 'stream') {
        await this.downloadStream();
      } else {
        throw new Error('Unknown download type: ' + this.downloadType);
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        this.reportStatus('cancelled', 'Cancelled');
      } else {
        console.error('[MediaSniff Offscreen] Download error:', err);
        this.reportStatus('failed', 'Error: ' + err.message);
      }
    } finally {
      activeDownloads.delete(this.itemId);
    }
  }
  async downloadStream() {
    let targetUrl = this.item.url;
    let segments = null;
    let initUrl = null;
    const qualityIndex = this.options.qualityIndex !== undefined ? parseInt(this.options.qualityIndex) : 0;
    if (this.item.variants && this.item.variants.length > 0) {
      const variant = this.item.variants[qualityIndex];
      targetUrl = variant.url;
      segments = variant.segments;
      initUrl = variant.initUrl;
    }
    if (!segments) {
      this.reportProgress(5, 'Parsing stream...', '');
      const resp = await fetch(targetUrl, { signal: this.abortController.signal });
      const text = await resp.text();
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, targetUrl);
      if (parsed.type === 'media') {
        segments = parsed.segments;
        initUrl = parsed.initSegment?.url || null;
      } else {
        const firstVariant = parsed.variants[0];
        const resp2 = await fetch(firstVariant.url, { signal: this.abortController.signal });
        const text2 = await resp2.text();
        const parsed2 = HLSParser.parse(text2, firstVariant.url);
        segments = parsed2.segments;
        initUrl = parsed2.initSegment?.url || null;
      }
    }
    if (!segments || segments.length === 0) {
      throw new Error('No segments found');
    }
    this.downloader = new SegmentDownloader({
      concurrency: 8,
      onProgress: (p) => {
        this.reportProgress(
          p.percent,
          `Downloading chunks: ${p.completed}/${p.total}`,
          p.speedLabel
        );
      }
    });
    this.downloader.abortController = this.abortController; // share abort controller
    const result = await this.downloader.downloadAll(segments, initUrl);
    this.reportProgress(95, 'Merging chunks...', '');
    const blob = Transmuxer.merge(result.init, result.segments);
    await this.triggerSave(blob, this.options.filename);
    this.reportStatus('complete', 'Complete!');
  }
  async downloadMux() {
    const qualityIndex = this.options.qualityIndex !== undefined ? parseInt(this.options.qualityIndex) : 0;
    const audioIndex = this.options.audioIndex !== undefined ? parseInt(this.options.audioIndex) : 0;
    const videoVariant = this.item.variants[qualityIndex];
    const audioRendition = this.item.audioRenditions[audioIndex];
    // 1. Download video
    this.reportProgress(5, 'Downloading video...', '');
    let videoSegments = videoVariant.segments;
    let videoInitUrl = videoVariant.initUrl;
    if (!videoSegments) {
      const resp = await fetch(videoVariant.url, { signal: this.abortController.signal });
      const text = await resp.text();
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, videoVariant.url);
      videoSegments = parsed.segments;
      videoInitUrl = parsed.initSegment?.url;
    }
    const videoDownloader = new SegmentDownloader({
      concurrency: 8,
      onProgress: (p) => {
        const overall = Math.round(p.percent * 0.4);
        this.reportProgress(overall, `Video: ${p.completed}/${p.total}`, p.speedLabel);
      }
    });
    videoDownloader.abortController = this.abortController;
    const videoResult = await videoDownloader.downloadAll(videoSegments, videoInitUrl);
    const videoBlob = Transmuxer.merge(videoResult.init, videoResult.segments);
    // 2. Download audio
    this.reportProgress(40, 'Downloading audio...', '');
    let audioSegments = audioRendition.segments;
    let audioInitUrl = audioRendition.initUrl;
    if (!audioSegments && audioRendition.url) {
      const resp = await fetch(audioRendition.url, { signal: this.abortController.signal });
      const text = await resp.text();
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, audioRendition.url);
      audioSegments = parsed.segments;
      audioInitUrl = parsed.initSegment?.url;
    }
    let audioBlob = null;
    if (audioSegments) {
      const audioDownloader = new SegmentDownloader({
        concurrency: 8,
        onProgress: (p) => {
          const overall = Math.round(40 + p.percent * 0.3);
          this.reportProgress(overall, `Audio: ${p.completed}/${p.total}`, p.speedLabel);
        }
      });
      audioDownloader.abortController = this.abortController;
      const audioResult = await audioDownloader.downloadAll(audioSegments, audioInitUrl);
      audioBlob = Transmuxer.merge(audioResult.init, audioResult.segments);
    }
    // 3. Mux
    this.reportProgress(75, 'Muxing tracks (WASM)...', '');
    const videoBuffer = await videoBlob.arrayBuffer();
    const audioBuffer = audioBlob ? await audioBlob.arrayBuffer() : null;
    const muxedBlob = await WASMMuxer.mux(videoBuffer, audioBuffer, (progress) => {
      const overall = Math.round(75 + progress * 0.20);
      this.reportProgress(overall, 'Muxing tracks (WASM)...', '');
    });
    // 4. Subtitle auto-embed if requested
    if (this.options.embedSub && this.item.subtitles?.length > 0) {
      this.reportProgress(96, 'Downloading subtitle...', '');
      const subUrl = this.item.subtitles[0].url;
      const subResp = await fetch(subUrl, { signal: this.abortController.signal });
      const subBlob = await subResp.blob();
      const subName = this.options.filename.replace(/\.[^.]+$/, '') + '.' + (this.item.subtitles[0].format || 'vtt');
      await this.triggerSave(subBlob, subName);
    }
    // 5. Save video
    this.reportProgress(98, 'Saving video...', '');
    await this.triggerSave(muxedBlob, this.options.filename);
    this.reportStatus('complete', 'Complete!');
  }
  async downloadYouTube() {
    this.reportProgress(5, 'Resolving YouTube URL...', '');
    
    let videoUrl = null;
    let audioUrl = null;
    let isCombined = false;
    let resultFilename = this.options.filename;

    if (this.item.rawAdaptiveFormats && this.item.rawAdaptiveFormats.length > 0) {
      try {
        console.log(`[MediaSniff Offscreen] Resolving stream directly from intercepted formats!`);
        const adaptiveFormats = this.item.rawAdaptiveFormats;
        const formats = this.item.rawFormats || [];
        
        const hasCipher = adaptiveFormats.some(f => f.signatureCipher || f.cipher)
          || formats.some(f => f.signatureCipher || f.cipher);
          
        let decipher = null;
        if (hasCipher && this.item.jsUrl) {
          decipher = await YouTubeDownloader.getDecipherFunction(this.item.jsUrl);
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
            urlObj.searchParams.set('ratebypass', 'yes');
            return urlObj.href;
          }
          return parsed.url;
        };

        const targetHeight = parseInt(this.options.ytQuality) || 1080;
        
        const videoStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('video/'))
          .map(f => ({ ...f, resolvedUrl: resolveStreamUrl(f) }))
          .filter(f => f.resolvedUrl)
          .sort((a, b) => (b.height || 0) - (a.height || 0));
          
        const audioStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('audio/'))
          .map(f => ({ ...f, resolvedUrl: resolveStreamUrl(f) }))
          .filter(f => f.resolvedUrl)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          
        let bestVideo = videoStreams.find(f => (f.height || 0) <= targetHeight) || videoStreams[0];
        if (bestVideo) {
          videoUrl = bestVideo.resolvedUrl;
          audioUrl = audioStreams[0]?.resolvedUrl || null;
          isCombined = false;
        }
      } catch (err) {
        console.warn(`[MediaSniff Offscreen] Direct resolution from memory registry failed:`, err.message);
      }
    }

    // Fallback: If not resolved directly or failed, fetch via our network signature/Invidious scraper
    if (!videoUrl) {
      console.log(`[MediaSniff Offscreen] Direct memory resolution unavailable, starting network download url request`);
      const result = await YouTubeDownloader.getDownloadUrl(this.item.url, this.options.ytQuality || '1080');
      videoUrl = result?.url;
      audioUrl = result?.audioUrl;
      isCombined = result?.isCombined;
      resultFilename = result?.filename || resultFilename;
    }

    if (this.item.directVideoUrls && this.item.directVideoUrls[this.options.ytQuality]) {
      videoUrl = this.item.directVideoUrls[this.options.ytQuality];
      audioUrl = this.item.directAudioUrls && this.item.directAudioUrls['default'];
      isCombined = false; // Intercepted player streams are separate formats
      console.log(`[MediaSniff Offscreen] Intercepted stream detected in registry:`, videoUrl);
    }
    
    if (!videoUrl) {
      throw new Error('API_UNAVAILABLE');
    }
    
    // ─── Pipeline 1: Native Messaging Companion App (Lossless FFmpeg Merging) ───
    try {
      this.reportProgress(8, 'Connecting to Companion App...', '');
      const nativeResult = await this.triggerNativeDownload(
        videoUrl,
        audioUrl,
        resultFilename
      );
      if (nativeResult && nativeResult.status === 'complete') {
        this.reportStatus('complete', nativeResult.statusLabel || 'Complete!');
        return;
      }
    } catch (e) {
      console.warn('[MediaSniff Offscreen] Companion App failed or not installed. Falling back to WASM:', e.message);
    }
    // ─── Pipeline 2: In-Browser WASM Muxer / Downloader Fallback ───
    let finalBlob;

    if (isCombined) {
      // Combined stream: download in one go
      this.reportProgress(10, 'Downloading from YouTube...', '');
      finalBlob = await YouTubeDownloader.downloadStream(
        videoUrl,
        (p) => {
          const overall = Math.round(10 + p.percent * 0.85); // 10% to 95%
          this.reportProgress(overall, `Downloading: ${p.sizeLabel}`, p.speedLabel);
        },
        this.abortController.signal
      );
    } else {
      // Adaptive stream: download video & audio separately, then mux entirely in-browser
      this.reportProgress(10, 'Downloading video stream...', '');
      const videoBlob = await YouTubeDownloader.downloadStream(
        videoUrl,
        (p) => {
          const overall = Math.round(10 + p.percent * 0.40); // 10% to 50%
          this.reportProgress(overall, `Video: ${p.sizeLabel}`, p.speedLabel);
        },
        this.abortController.signal
      );
      let audioBlob = null;

      if (audioUrl) {
        this.reportProgress(50, 'Downloading audio stream...', '');
        audioBlob = await YouTubeDownloader.downloadStream(
          audioUrl,
          (p) => {
            const overall = Math.round(50 + p.percent * 0.30); // 50% to 80%
            this.reportProgress(overall, `Audio: ${p.sizeLabel}`, p.speedLabel);
          },
          this.abortController.signal
        );
      }
      this.reportProgress(80, 'Remuxing tracks (WASM)...', '');
      const videoBuffer = await videoBlob.arrayBuffer();
      const audioBuffer = audioBlob ? await audioBlob.arrayBuffer() : null;
      const muxedBlob = await WASMMuxer.mux(videoBuffer, audioBuffer, (progress) => {
        const overall = Math.round(80 + progress * 0.16); // 80% to 96%
        this.reportProgress(overall, 'Remuxing tracks (WASM)...', '');
      });
      finalBlob = muxedBlob;
    }
    this.reportProgress(98, 'Saving video...', '');
    await this.triggerSave(finalBlob, resultFilename);
    this.reportStatus('complete', 'Complete!');
  }
  triggerNativeDownload(videoUrl, audioUrl, filename) {
    return new Promise((resolve, reject) => {
      try {
        const port = chrome.runtime.connectNative("net.mediasniff.coapp");

        port.onMessage.addListener((msg) => {
          console.log("[MediaSniff Offscreen] Native Companion message:", msg);
          if (msg.status === 'progress') {
            this.reportProgress(msg.percent, msg.statusLabel, '');
          } else if (msg.status === 'complete') {
            port.disconnect();
            resolve(msg);
          } else if (msg.status === 'failed') {
            port.disconnect();
            reject(new Error(msg.statusLabel || 'Native Host failed'));
          }
        });

        port.onDisconnect.addListener(() => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn("[MediaSniff Offscreen] Native connection error:", err.message);
            reject(new Error("Host disconnected: " + err.message));
          } else {
            resolve({ status: "complete", statusLabel: "Completed by Companion App" });
          }
        });

        // Trigger native download & mux action
        port.postMessage({
          action: "download_and_mux",
          videoUrl: videoUrl,
          audioUrl: audioUrl,
          filename: filename
        });

      } catch (err) {
        reject(err);
      }
    });
  }
  async triggerSave(blob, filename) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'TRIGGER_DOWNLOAD_SAVE',
        url: url,
        filename: filename
      }, (response) => {
        // Clean up URL
        setTimeout(() => URL.revokeObjectURL(url), 20000);
        if (response && response.success) {
          resolve(response.downloadId);
        } else {
          reject(new Error(response?.error || 'Download failed to trigger'));
        }
      });
    });
  }
  cancel() {
    this.abortController.abort();
    if (this.downloader) this.downloader.abort();
  }
  reportProgress(percent, statusLabel, speedLabel) {
    chrome.runtime.sendMessage({
      type: 'BACKGROUND_DOWNLOAD_PROGRESS',
      itemId: this.itemId,
      status: 'downloading',
      percent,
      statusLabel,
      speedLabel
    });
  }
  reportStatus(status, statusLabel) {
    chrome.runtime.sendMessage({
      type: 'BACKGROUND_DOWNLOAD_PROGRESS',
      itemId: this.itemId,
      status,
      percent: status === 'complete' ? 100 : 0,
      statusLabel,
      speedLabel: ''
    });
  }
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_BACKGROUND_DOWNLOAD') {
    const { itemId, item, downloadType, options } = message;
    if (activeDownloads.has(itemId)) return;
    const task = new DownloadTask(itemId, item, downloadType, options);
    activeDownloads.set(itemId, task);
    task.start();
  }
  if (message.type === 'CANCEL_BACKGROUND_DOWNLOAD') {
    const { itemId } = message;
    const task = activeDownloads.get(itemId);
    if (task) {
      task.cancel();
    }
  }
});