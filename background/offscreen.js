import { SegmentDownloader } from '../lib/segment-downloader.js';
import { Transmuxer } from '../lib/transmuxer.js';
import { WASMMuxer } from '../lib/muxer.js';
import { YouTubeDownloader } from '../lib/youtube-downloader.js';

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
    this.reportProgress(5, 'Preparing YouTube download...', '');

    const targetQuality = this.options.ytQuality || '1080';
    const tabId = this.item.tabId || this.options.tabId;
    const watchUrl = this.item.url;
    
    console.log(`[MediaSniff Offscreen] YouTube Download: Target=${targetQuality}p, TabID=${tabId}`);

    // ─── Try Pipeline 1: Native Companion App with yt-dlp (Gold Standard) ───
    try {
      this.reportProgress(8, 'Connecting to Companion App (yt-dlp)...', '');
      const nativeResult = await this.triggerNativeYtdlpDownload(
        watchUrl,
        this.options.filename,
        targetQuality
      );
      if (nativeResult && nativeResult.status === 'complete') {
        this.reportStatus('complete', nativeResult.statusLabel || 'Complete!');
        return;
      }
    } catch (e) {
      console.warn('[MediaSniff Offscreen] Native yt-dlp download failed, falling back to sniffer/WASM:', e.message);
    }

    let videoUrl = null;
    let audioUrl = null;
    let isCombined = false;
    let videoHeaders = null;
    let audioHeaders = null;
    let result = null;

    // Wait for raw stream interception and force player quality switch with buffer invalidation
    if (tabId) {
      this.reportProgress(8, 'Polling sniffer registry for streams...', '');
      
      for (let attempt = 1; attempt <= 6; attempt++) {
        // Query the latest state of this item from background session storage registry
        const latestMedia = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'GET_MEDIA_ITEM', tabId, itemId: this.item.id }, (resp) => {
            resolve(resp?.item || this.item);
          });
        });
        
        const directVideo = latestMedia.directVideoUrls?.[targetQuality];
        const directAudio = latestMedia.directAudioUrls?.['default'];
        
        console.log(`[MediaSniff Offscreen] Registry Check (Attempt ${attempt}/6):`, {
          videoFound: !!directVideo,
          audioFound: !!directAudio
        });

        if (directVideo && directVideo.url && directAudio && directAudio.url) {
          // DASH Stabilization delay: wait 1.5 seconds to collect all audio/video range chunks
          this.reportProgress(10, 'Synchronizing DASH streams...', '');
          await new Promise(r => setTimeout(r, 1500));
          
          videoUrl = directVideo.url;
          videoHeaders = directVideo.headers || null;
          audioUrl = directAudio.url;
          audioHeaders = directAudio.headers || null;
          isCombined = false;
          
          result = {
            url: videoUrl,
            audioUrl: audioUrl,
            filename: this.options.filename,
            quality: targetQuality,
            isCombined: false,
            videoType: directVideo.mime || 'video/mp4',
            audioType: directAudio?.mime || 'audio/mp4'
          };
          break;
        }

        // Programmatically force quality switch with buffer invalidation if not intercepted yet
        if (!directVideo && (attempt === 1 || attempt === 3)) {
          this.reportProgress(8, `Forcing player quality switch to ${targetQuality}p...`, '');
          await chrome.runtime.sendMessage({ type: 'FORCE_QUALITY_SWITCH', tabId, quality: targetQuality });
        } else if (!directAudio) {
          this.reportProgress(8, 'Waiting for audio stream synchronization...', '');
        }

        // Wait 1.5 seconds before next polling check
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // First Fallback: Scan registry for ANY quality that has been intercepted
    if (!videoUrl && tabId) {
      console.log(`[MediaSniff Offscreen] Exact quality not found. Checking for any other captured video qualities...`);
      const latestMedia = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_MEDIA_ITEM', tabId, itemId: this.item.id }, (resp) => {
          resolve(resp?.item || this.item);
        });
      });
      
      const qualities = Object.keys(latestMedia.directVideoUrls || {}).sort((a, b) => parseInt(b) - parseInt(a));
      if (qualities.length > 0) {
        const bestQuality = qualities[0];
        const directVideo = latestMedia.directVideoUrls[bestQuality];
        const directAudio = latestMedia.directAudioUrls?.['default'];

        console.log(`[MediaSniff Offscreen] Falling back to highest captured direct stream quality: ${bestQuality}p`);
        videoUrl = directVideo.url;
        videoHeaders = directVideo.headers || null;
        isCombined = false;

        if (directAudio && directAudio.url) {
          audioUrl = directAudio.url;
          audioHeaders = directAudio.headers || null;
        }

        result = {
          url: videoUrl,
          audioUrl: audioUrl,
          filename: this.options.filename,
          quality: bestQuality,
          isCombined: false,
          videoType: directVideo.mime || 'video/mp4',
          audioType: directAudio?.mime || 'audio/mp4'
        };
      }
    }

    // Last Resort Fallback: Invidious API
    if (!videoUrl) {
      this.reportProgress(12, 'Sniffer inactive. Resolving streams via fallback API...', '');
      try {
        result = await YouTubeDownloader.getDownloadUrl(this.item.url, targetQuality);
        videoUrl = result?.url;
        audioUrl = result?.audioUrl;
        isCombined = result?.isCombined;
      } catch (e) {
        console.warn(`[MediaSniff Offscreen] Fallback API query failed:`, e.message);
      }
    }

    if (!videoUrl) {
      throw new Error('API_UNAVAILABLE');
    }

    try {
      if (isCombined) {
        // Combined stream: download in one go
        this.reportProgress(10, 'Downloading from YouTube...', '');
        const finalBlob = await YouTubeDownloader.downloadStream(
          videoUrl,
          (p) => {
            const overall = Math.round(10 + p.percent * 0.85); // 10% to 95%
            this.reportProgress(overall, `Downloading: ${p.sizeLabel}`, p.speedLabel);
          },
          this.abortController.signal
        );
        this.reportProgress(98, 'Saving video...', '');
        await this.triggerSave(finalBlob, result?.filename || this.options.filename);
        this.reportStatus('complete', 'Complete!');
      } else {
        // Try the separate adaptive streams (via Companion App first, then in-browser WASM)
        await this.downloadAdaptive(videoUrl, audioUrl, result, videoHeaders, audioHeaders);
      }
    } catch (err) {
      console.warn('[MediaSniff Offscreen] Adaptive download/merge failed:', err.message);
      
      // Fallback to combined stream if available
      if (result?.combinedUrl && !isCombined) {
        this.reportProgress(10, 'Retrying in Safe Mode...', '');
        try {
          const finalBlob = await YouTubeDownloader.downloadStream(
            result.combinedUrl,
            (p) => {
              const overall = Math.round(10 + p.percent * 0.85);
              this.reportProgress(overall, `Downloading (Safe Mode): ${p.sizeLabel}`, p.speedLabel);
            },
            this.abortController.signal
          );
          this.reportProgress(98, 'Saving video...', '');
          await this.triggerSave(finalBlob, result.filename || this.options.filename);
          this.reportStatus('complete', 'Complete (Safe Mode)!');
        } catch (err2) {
          throw new Error('Safe Mode download failed: ' + err2.message);
        }
      } else {
        throw err;
      }
    }
  }

  async downloadAdaptive(videoUrl, audioUrl, result, videoHeaders = null, audioHeaders = null) {
    // ─── Pipeline 1: Native Messaging Companion App (Lossless FFmpeg Merging) ───
    try {
      this.reportProgress(8, 'Connecting to Companion App...', '');
      const nativeResult = await this.triggerNativeDownload(
        videoUrl, 
        audioUrl, 
        result?.filename || this.options.filename,
        videoHeaders,
        audioHeaders
      );
      if (nativeResult && nativeResult.status === 'complete') {
        this.reportStatus('complete', nativeResult.statusLabel || 'Complete!');
        return;
      }
    } catch (e) {
      console.warn('[MediaSniff Offscreen] Companion App failed or not installed. Falling back to WASM:', e.message);
    }

    // ─── Pipeline 2: In-Browser WASM Muxer / Downloader Fallback ───
    // Check if the stream is VP9/AV1 (not AVC/H.264)
    const isAVC = (type) => {
      const t = String(type || '').toLowerCase();
      return t.includes('avc1') || t.includes('h264') || t.includes('avc');
    };
    
    const videoType = result?.videoType || '';
    if (!isAVC(videoType)) {
      console.warn('[MediaSniff Offscreen] Video stream is not standard AVC/H.264 (likely VP9 or AV1). WASM box-muxing of this format is unstable and unsupported by default Windows players. Falling back to pre-muxed combined H.264 stream.');
      throw new Error('CODEC_NOT_SUPPORTED_IN_BROWSER');
    }

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

    this.reportProgress(98, 'Saving video...', '');
    await this.triggerSave(muxedBlob, result?.filename || this.options.filename);
    this.reportStatus('complete', 'Complete!');
  }

  triggerNativeYtdlpDownload(url, filename, quality) {
    return new Promise((resolve, reject) => {
      try {
        const port = chrome.runtime.connectNative("net.mediasniff.coapp");
        
        port.onMessage.addListener((msg) => {
          console.log("[MediaSniff Offscreen] Native Ytdlp Companion message:", msg);
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
            console.warn("[MediaSniff Offscreen] Native Ytdlp connection error:", err.message);
            reject(new Error("Host disconnected: " + err.message));
          } else {
            resolve({ status: "complete", statusLabel: "Completed by Companion App (yt-dlp)" });
          }
        });
        
        // Trigger native download via yt-dlp action
        port.postMessage({
          action: "download_youtube_ytdlp",
          url: url,
          filename: filename,
          quality: quality
        });
        
      } catch (err) {
        reject(err);
      }
    });
  }

  triggerNativeDownload(videoUrl, audioUrl, filename, videoHeaders = null, audioHeaders = null) {
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
          filename: filename,
          videoHeaders: videoHeaders,
          audioHeaders: audioHeaders
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
