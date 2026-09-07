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
  async fetchPlaylist(url, referer) {
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_MANIFEST', url, referer }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      });
      if (response && response.success && response.text) {
        return response.text;
      }
    } catch (_) {}

    const resp = await fetch(url, { signal: this.abortController.signal, credentials: 'include' });
    if (!resp.ok) {
      throw new Error(`Failed to fetch playlist (${resp.status} ${resp.statusText || 'Error'})`);
    }
    return await resp.text();
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
    } else if (this.item.segments && this.item.segments.length > 0) {
      segments = this.item.segments;
      initUrl = this.item.initUrl;
    }
    const referer = this.options.referer || this.item.referer || null;
    if (!segments || segments.length === 0) {
      this.reportProgress(5, 'Parsing stream...', '');
      const text = await this.fetchPlaylist(targetUrl, referer);
      let parsed;
      if (text.trim().startsWith('#EXTM3U')) {
        const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
        parsed = HLSParser.parse(text, targetUrl);
      } else if (text.trim().startsWith('<') && text.includes('<MPD')) {
        const { DASHParser } = await import(chrome.runtime.getURL('lib/dash-parser.js'));
        parsed = DASHParser.parse(text, targetUrl);
      } else {
        throw new Error('Unknown manifest format');
      }
      if (parsed.type === 'media' || (parsed.segments && parsed.segments.length > 0)) {
        segments = parsed.segments;
        initUrl = parsed.initSegment || null;
      } else if (parsed.variants && parsed.variants.length > 0) {
        const firstVariant = parsed.variants[0];
        const text2 = await this.fetchPlaylist(firstVariant.url, referer);
        const parsed2 = HLSParser.parse(text2, firstVariant.url);
        segments = parsed2.segments;
        initUrl = parsed2.initSegment || null;
      }
    }
    if (!segments || segments.length === 0) {
      throw new Error('No segments found');
    }
    this.downloader = new SegmentDownloader({
      concurrency: 8,
      referer,
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
    this.reportProgress(90, 'Assembling video...', '');
    const format = Transmuxer.detectFormat(result.init, result.segments[0]);

    let finalBlob;
    let finalFilename = this.options.filename || 'download';

    if (format === 'ts') {
      // MPEG-TS segments: TS already contains muxed audio+video.
      // Simple concatenation produces a valid TS file.
      // We MUST ensure the extension is .ts — saving TS data with .mp4
      // extension causes "can't open this file" because players try to
      // parse it as ISO BMFF and fail.
      this.reportProgress(92, 'Merging TS segments...', '');
      const parts = [];
      for (const seg of result.segments) {
        if (seg) parts.push(seg);
      }
      finalBlob = new Blob(parts, { type: 'video/mp2t' });
      // Force .ts extension
      finalFilename = finalFilename.replace(/\.[^.]+$/, '.ts');
    } else {
      // fMP4/CMAF segments: init segment (ftyp+moov) + media segments
      // (moof+mdat). Build a proper MP4 by concatenating init + segments
      // through WASMMuxer for correct box-level assembly.
      this.reportProgress(92, 'Building MP4 container...', '');
      try {
        const rawBlob = Transmuxer.merge(result.init, result.segments);
        const rawBuffer = await rawBlob.arrayBuffer();
        // Route through WASMMuxer which handles fMP4 box-level assembly
        // properly (moov merging, track IDs, fragment ordering)
        finalBlob = await WASMMuxer.mux(rawBuffer, null, (progress) => {
          const overall = Math.round(92 + progress * 0.06);
          this.reportProgress(overall, 'Building MP4 container...', '');
        });
      } catch (muxErr) {
        console.warn('[MediaSniff Offscreen] WASMMuxer failed, using direct merge:', muxErr.message);
        // Fallback: direct concatenation (init + segments) should still
        // produce a playable fMP4 file for most players
        finalBlob = Transmuxer.merge(result.init, result.segments);
      }
      // Ensure .mp4 extension
      if (!/\.mp4$/i.test(finalFilename)) {
        finalFilename = finalFilename.replace(/\.[^.]+$/, '.mp4');
      }
    }

    await this.triggerSave(finalBlob, finalFilename);
    this.reportStatus('complete', 'Complete!');
  }
  async downloadMux() {
    const qualityIndex = this.options.qualityIndex !== undefined ? parseInt(this.options.qualityIndex) : 0;
    const audioIndex = this.options.audioIndex !== undefined ? parseInt(this.options.audioIndex) : 0;
    const videoVariant = this.item.variants[qualityIndex];
    const audioRendition = this.item.audioRenditions?.[audioIndex];
    const referer = this.options.referer || this.item.referer || null;

    // 1. Download video
    this.reportProgress(5, 'Downloading video...', '');
    let videoSegments = videoVariant?.segments;
    let videoInitUrl = videoVariant?.initUrl;
    if ((!videoSegments || videoSegments.length === 0) && videoVariant?.url) {
      this.reportProgress(6, 'Fetching video playlist...', '');
      const text = await this.fetchPlaylist(videoVariant.url, referer);
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, videoVariant.url);
      if (parsed.segments && parsed.segments.length > 0) {
        videoSegments = parsed.segments;
        videoInitUrl = parsed.initSegment || null;
      } else if (parsed.variants && parsed.variants.length > 0) {
        const vFirst = parsed.variants[0];
        const vText2 = await this.fetchPlaylist(vFirst.url, referer);
        const vParsed2 = HLSParser.parse(vText2, vFirst.url);
        videoSegments = vParsed2.segments;
        videoInitUrl = vParsed2.initSegment || null;
      }
    }
    if (!videoSegments || videoSegments.length === 0) {
      throw new Error('No video segments found');
    }
    const videoDownloader = new SegmentDownloader({
      concurrency: 8,
      referer,
      onProgress: (p) => {
        const overall = Math.round(p.percent * 0.4);
        this.reportProgress(overall, `Video: ${p.completed}/${p.total}`, p.speedLabel);
      }
    });
    videoDownloader.abortController = this.abortController;
    let videoResult = await videoDownloader.downloadAll(videoSegments, videoInitUrl);
    const videoBuffer = await Transmuxer.merge(videoResult.init, videoResult.segments).arrayBuffer();
    videoResult = null;
    // 2. Download audio
    this.reportProgress(40, 'Downloading audio...', '');
    let audioSegments = audioRendition?.segments;
    let audioInitUrl = audioRendition?.initUrl;
    if ((!audioSegments || audioSegments.length === 0) && audioRendition?.url) {
      this.reportProgress(41, 'Fetching audio playlist...', '');
      const text = await this.fetchPlaylist(audioRendition.url, referer);
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsed = HLSParser.parse(text, audioRendition.url);
      if (parsed.segments && parsed.segments.length > 0) {
        audioSegments = parsed.segments;
        audioInitUrl = parsed.initSegment || null;
      } else if (parsed.variants && parsed.variants.length > 0) {
        const aFirst = parsed.variants[0];
        const aText2 = await this.fetchPlaylist(aFirst.url, referer);
        const aParsed2 = HLSParser.parse(aText2, aFirst.url);
        audioSegments = aParsed2.segments;
        audioInitUrl = aParsed2.initSegment || null;
      }
    }
    let audioBuffer = null;
    if (audioSegments) {
      const audioDownloader = new SegmentDownloader({
        concurrency: 8,
        referer,
        onProgress: (p) => {
          const overall = Math.round(40 + p.percent * 0.3);
          this.reportProgress(overall, `Audio: ${p.completed}/${p.total}`, p.speedLabel);
        }
      });
      audioDownloader.abortController = this.abortController;
      let audioResult = await audioDownloader.downloadAll(audioSegments, audioInitUrl);
      audioBuffer = await Transmuxer.merge(audioResult.init, audioResult.segments).arrayBuffer();
      audioResult = null;
    }
    // 3. Mux
    this.reportProgress(75, 'Muxing tracks (WASM)...', '');
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
    // 5. Save video — detect actual output format and fix extension
    this.reportProgress(98, 'Saving video...', '');
    let muxFilename = this.options.filename;
    const muxedBuffer = await muxedBlob.arrayBuffer();
    const outputFormat = WASMMuxer.detectFormat(muxedBuffer);
    if (outputFormat === 'ts') {
      muxFilename = muxFilename.replace(/\.[^.]+$/, '.ts');
    } else if (!/\.mp4$/i.test(muxFilename)) {
      muxFilename = muxFilename.replace(/\.[^.]+$/, '.mp4');
    }
    await this.triggerSave(new Blob([muxedBuffer], { type: outputFormat === 'ts' ? 'video/mp2t' : 'video/mp4' }), muxFilename);
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

        console.log(`[MediaSniff YouTube] adaptiveFormats count: ${adaptiveFormats.length}, formats count: ${formats.length}`);

        // Log what URL/cipher data we have
        const withUrl = adaptiveFormats.filter(f => f.url);
        const withCipher = adaptiveFormats.filter(f => f.signatureCipher || f.cipher);
        console.log(`[MediaSniff YouTube] Formats with direct URL: ${withUrl.length}, with cipher: ${withCipher.length}`);

        const hasCipher = adaptiveFormats.some(f => f.signatureCipher || f.cipher)
          || formats.some(f => f.signatureCipher || f.cipher);

        let decipher = null;
        if (hasCipher && this.item.jsUrl) {
          try {
            decipher = await YouTubeDownloader.getDecipherFunction(this.item.jsUrl);
          } catch(e) {
          }
          console.log(`[MediaSniff YouTube] Decipher function: ${decipher ? 'LOADED' : 'FAILED'}`);
        }

        const parseCipher = (cipher) => {
          const params = new URLSearchParams(cipher);
          return {
            url: params.get('url'),
            s: params.get('s'),
            sp: params.get('sp') || 'sig'
          };
        };

        const resolveStreamUrl = (fmt) => {
          if (fmt.url) return fmt.url;
          const cipherStr = fmt.signatureCipher || fmt.cipher;
          if (!cipherStr) return null;

          const parsed = parseCipher(cipherStr);
          if (!parsed.url) return null;


          if (parsed.s && decipher) {
            try {
              const signature = decipher(parsed.s);
              const urlObj = new URL(parsed.url);
              urlObj.searchParams.set(parsed.sp, signature);
              urlObj.searchParams.set('ratebypass', 'yes');
              return urlObj.href;
            } catch (err) {
              return parsed.url;
            }
          }
          return parsed.url;
        };

        const targetHeight = parseInt(this.options.ytQuality) || 1080;

        const videoStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('video/') && (f.mimeType?.includes('mp4') || f.mimeType?.includes('webm')))
          .map(f => {
             try {
                return { ...f, resolvedUrl: resolveStreamUrl(f) };
             } catch(e) {
                return { ...f, resolvedUrl: null };
             }
          })
          .filter(f => f.resolvedUrl)
          .sort((a, b) => {
            const ha = a.height || 0;
            const hb = b.height || 0;
            if (ha !== hb) return hb - ha;
            return (b.bitrate || 0) - (a.bitrate || 0);
          });

        const audioStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('audio/') && (f.mimeType?.includes('mp4') || f.mimeType?.includes('webm')))
          .map(f => {
             try {
                return { ...f, resolvedUrl: resolveStreamUrl(f) };
             } catch(e) {
                return { ...f, resolvedUrl: null };
             }
          })
          .filter(f => f.resolvedUrl)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        console.log(`[MediaSniff YouTube] Resolved video streams: ${videoStreams.length}, audio streams: ${audioStreams.length}`);

        let bestVideo = videoStreams.find(f => (f.height || 0) <= targetHeight) || videoStreams[0];
        if (bestVideo) {
          videoUrl = bestVideo.resolvedUrl;

          // Match the audio stream format container (webm vs mp4) to the video container
          const isWebmVideo = bestVideo.mimeType?.includes('webm');
          const matchedAudio = audioStreams.find(a => isWebmVideo ? a.mimeType?.includes('webm') : a.mimeType?.includes('mp4'))
            || audioStreams[0];

          audioUrl = matchedAudio?.resolvedUrl || null;
          const title = this.item.title || 'Video';
          const defaultName = `${title}${isWebmVideo ? '.webm' : '.mp4'}`;
          resultFilename = this.options.filename || defaultName;
          if (isWebmVideo && !resultFilename.endsWith('.webm')) {
            resultFilename = resultFilename.replace(/\.[^.]+$/, '') + '.webm';
          }
          
          console.log(`[MediaSniff YouTube] Selected video: ${bestVideo.height}p ${bestVideo.mimeType}, audio: ${matchedAudio ? matchedAudio.mimeType : 'NONE'}, file: ${resultFilename}`);
        } else {
          console.warn(`[MediaSniff YouTube] No video streams could be resolved from rawAdaptiveFormats`);
        }
      } catch (err) {
        console.warn(`[MediaSniff Offscreen] Direct resolution from memory registry failed:`, err.message);
      }
    } else {
      console.log(`[MediaSniff YouTube] No rawAdaptiveFormats available on this item`);
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
      // Only override audioUrl if a direct intercepted audio URL actually exists.
      // Otherwise keep the audioUrl already resolved from rawAdaptiveFormats/getDownloadUrl
      // — overwriting it with undefined was causing no-audio downloads.
      const directAudio = this.item.directAudioUrls && this.item.directAudioUrls['default'];
      if (directAudio) {
        audioUrl = directAudio;
      }
      isCombined = false;
      console.log(`[MediaSniff Offscreen] Intercepted stream detected in registry:`, videoUrl);
    }
    
    if (!videoUrl) {
      throw new Error('API_UNAVAILABLE');
    }

    console.log(`[MediaSniff YouTube] Video URL resolved: ${videoUrl ? 'YES' : 'NO'}`);
    console.log(`[MediaSniff YouTube] Audio URL resolved: ${audioUrl ? 'YES' : 'NO'}, isCombined: ${isCombined}`);
    
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

    if (!isCombined && resultFilename.endsWith('.webm') && this.item.rawAdaptiveFormats?.length > 0) {
      console.warn('[MediaSniff Offscreen] WASM Muxer cannot process WebM. Re-resolving to MP4 fallback.');
      try {
        const targetHeight = parseInt(this.options.ytQuality) || 1080;
        const mp4V = this.item.rawAdaptiveFormats
          .filter(f => f.mimeType?.startsWith('video/') && f.mimeType?.includes('mp4'))
          .sort((a, b) => ((b.height || 0) - (a.height || 0)) || ((b.bitrate || 0) - (a.bitrate || 0)));
        const bestMp4 = mp4V.find(f => (f.height || 0) <= targetHeight) || mp4V[0];

        const mp4A = this.item.rawAdaptiveFormats
          .filter(f => f.mimeType?.startsWith('audio/') && f.mimeType?.includes('mp4'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        
        if (bestMp4) {
          // Re-resolve URLs using basic fallback if no decipher available here
          const getUrl = (f) => f.url || new URLSearchParams(f.signatureCipher || f.cipher).get('url');
          videoUrl = getUrl(bestMp4);
          audioUrl = mp4A.length > 0 ? getUrl(mp4A[0]) : null;
          resultFilename = resultFilename.replace(/\.webm$/, '.mp4');
        }
      } catch (e) {
        console.warn('[MediaSniff Offscreen] Failed to fallback to MP4:', e.message);
      }
    }

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
        try {
          this.reportProgress(50, 'Downloading audio stream...', '');
          audioBlob = await YouTubeDownloader.downloadStream(
            audioUrl,
            (p) => {
              const overall = Math.round(50 + p.percent * 0.30); // 50% to 80%
              this.reportProgress(overall, `Audio: ${p.sizeLabel}`, p.speedLabel);
            },
            this.abortController.signal
          );
        } catch (audioErr) {
          console.warn('[MediaSniff YouTube] Audio stream download failed, continuing with video only:', audioErr.message);
          audioBlob = null;
        }
      }

      this.reportProgress(80, 'Preparing to merge...', '');
      const videoBuffer = await videoBlob.arrayBuffer();
      const audioBuffer = audioBlob ? await audioBlob.arrayBuffer() : null;

      // Always attempt muxing through WASMMuxer.mux() — it auto-detects
      // whether the input is fragmented MP4 or standard MP4 and routes
      // to the correct muxing path (muxFMP4 or muxStandardMP4).
      this.reportProgress(85, 'Remuxing tracks (WASM)...', '');
      try {
        const muxedBlob = await WASMMuxer.mux(videoBuffer, audioBuffer, (progress) => {
          const overall = Math.round(85 + progress * 0.11); // 85% to 96%
          this.reportProgress(overall, 'Remuxing tracks (WASM)...', '');
        });
        finalBlob = muxedBlob;
      } catch (muxErr) {
        console.warn('[MediaSniff YouTube] WASM muxing failed, falling back to saving separate files:', muxErr.message);
        
        // Save video file
        await this.triggerSave(videoBlob, resultFilename);
        
        // Save audio file if available
        if (audioBlob) {
          const audioExt = resultFilename.includes('.webm') ? '.opus' : '.m4a';
          const audioFilename = resultFilename.replace(/\.[^.]+$/, '') + '.audio' + audioExt;
          await this.triggerSave(audioBlob, audioFilename);
          this.reportStatus('complete', 'Mux failed — saved separate video & audio files.');
        } else {
          this.reportStatus('complete', 'Saved video only (no audio available).');
        }
        return;
      }
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
    const sanitized = filename
      .replace(/_/g, ' ')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\.\./g, ' ')
      .replace(/^\.+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200) || 'download.mp4';

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'TRIGGER_DOWNLOAD_SAVE',
        url: url,
        filename: sanitized
      }, (response) => {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.success) {
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  if (message.type === 'PARSE_DASH_OFFSCREEN') {
    const { content, url } = message;
    import(chrome.runtime.getURL('lib/dash-parser.js')).then(({ DASHParser }) => {
      try {
        const parsed = DASHParser.parse(content, url);
        sendResponse({ parsed });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    }).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // async response
  }
});