import { SegmentDownloader } from '../lib/segment-downloader.js';
import { Transmuxer } from '../lib/transmuxer.js';
import { WASMMuxer } from '../lib/muxer.js';
import { TSToMP4Converter } from '../lib/ts-converter.js';
import { YouTubeDownloader } from '../lib/youtube-downloader.js';

export const MEDIA_SNIFF_BUILD = 'YT-AUDIO-FIX-2026-09-14-01';
console.log('[MediaSniff Offscreen] Build:', MEDIA_SNIFF_BUILD);

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

  getBestDirectVideoUrl(targetHeight) {
    const directVideos = this.item.directVideoUrls;
    if (!directVideos || typeof directVideos !== 'object') return null;

    let parsedTarget = 1080;
    if (targetHeight !== undefined && targetHeight !== null) {
      const match = String(targetHeight).match(/\d+/);
      if (match) parsedTarget = parseInt(match[0], 10);
    }

    const entries = [];
    let defaultUrl = null;

    for (const [key, url] of Object.entries(directVideos)) {
      if (!url || typeof url !== 'string') continue;
      if (key === 'default') {
        defaultUrl = url;
        continue;
      }
      const match = String(key).match(/\d+/);
      if (match) {
        entries.push({
          height: parseInt(match[0], 10),
          url
        });
      }
    }

    // Also inspect any stored availableQualities metadata on the item
    if (this.item.availableQualities && Array.isArray(this.item.availableQualities)) {
      for (const q of this.item.availableQualities) {
        if (q.height && !entries.some(e => e.height === q.height)) {
          const matched = directVideos[q.height] || directVideos[`${q.height}p`] || directVideos[q.label] || directVideos[q.itag];
          if (matched && typeof matched === 'string') {
            entries.push({ height: q.height, url: matched });
          }
        }
      }
    }

    entries.sort((a, b) => b.height - a.height);

    if (entries.length > 0) {
      // 1. Exact requested height
      const exact = entries.find(e => e.height === parsedTarget);
      if (exact) return exact.url;

      // 2. Highest height <= requested
      const candidate = entries.find(e => e.height <= parsedTarget);
      if (candidate) return candidate.url;

      // 3. Highest available overall
      return entries[0].url;
    }

    if (defaultUrl) return defaultUrl;

    const values = Object.values(directVideos).filter(v => typeof v === 'string' && v.length > 0);
    return values[0] || null;
  }

  getBestDirectAudioUrl(isWebm) {
    const directAudio = this.item.directAudioUrls;
    if (directAudio && typeof directAudio === 'object') {
      if (isWebm) {
        if (directAudio['webm']) return directAudio['webm'];
        if (directAudio['opus']) return directAudio['opus'];
      } else {
        // Prefer MP4 audio for the browser MP4 mux path
        if (directAudio['mp4']) return directAudio['mp4'];
        if (directAudio['m4a']) return directAudio['m4a'];
        if (directAudio['aac']) return directAudio['aac'];
      }
      if (directAudio['default']) return directAudio['default'];
      const values = Object.values(directAudio).filter(v => typeof v === 'string' && v.length > 0);
      if (values.length > 0) return values[0];
    }
    return this.item.audioUrl || null;
  }
  async start() {
    try {
      this.reportProgress(0, 'Preparing...', '');
      if (this.downloadType === 'youtube') {
        await this.downloadYouTube();
      } else if (this.downloadType === 'ytdlp') {
        await this.downloadYTDLP();
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
    // If the stream has separate audio renditions and video variants, delegate to downloadMux
    if (this.item.audioRenditions && this.item.audioRenditions.length > 0 && this.item.variants && this.item.variants.length > 0) {
      console.log('[MediaSniff Offscreen] Stream has separate audio renditions, delegating downloadStream to downloadMux');
      return await this.downloadMux();
    }

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

      if (parsed.audioRenditions && parsed.audioRenditions.length > 0 && parsed.variants && parsed.variants.length > 0) {
        console.log('[MediaSniff Offscreen] Parsed manifest has separate audio renditions, delegating to downloadMux');
        this.item.audioRenditions = parsed.audioRenditions;
        this.item.variants = parsed.variants;
        return await this.downloadMux();
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
      // MPEG-TS segments: Transmux H.264 video and AAC audio from TS
      // into a standard ISO BMFF MP4 container (.mp4).
      this.reportProgress(92, 'Converting MPEG-TS to MP4...', '');
      try {
        finalBlob = TSToMP4Converter.convert(result.segments, (progress) => {
          const overall = Math.round(92 + progress * 0.06);
          this.reportProgress(overall, 'Converting MPEG-TS to MP4...', '');
        });
      } catch (convErr) {
        console.error('[MediaSniff Offscreen] TSToMP4Converter failed:', convErr);
        throw new Error('Transmuxing MPEG-TS to MP4 failed: ' + convErr.message);
      }
      // Ensure .mp4 extension
      finalFilename = finalFilename.replace(/\.[^.]+$/, '') + '.mp4';
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
    const videoVariant = this.item.variants?.[qualityIndex] || this.item.variants?.[0];
    const audioRendition = this.item.audioRenditions?.[audioIndex] || this.item.audioRenditions?.[0];
    const referer = this.options.referer || this.item.referer || null;

    // 1. Download video
    this.reportProgress(5, 'Downloading video...', '');
    let videoSegments = videoVariant?.segments;
    let videoInitUrl = videoVariant?.initUrl;
    const videoUrl = videoVariant?.url || videoVariant?.uri;
    const isHls = this.item.streamType === 'hls' || this.item.type === 'hls' || Boolean(videoVariant?.isHls);

    // Direct stream track muxing (e.g. Instagram DASH single-file tracks, NEVER for HLS streams)
    if (!isHls && (!videoSegments || videoSegments.length === 0) && videoUrl && (videoVariant.isDash || videoVariant.isDirect || this.item.source === 'instagram')) {
      this.reportProgress(10, 'Downloading video track...', '');
      const respV = await fetch(videoUrl, { signal: this.abortController?.signal });
      if (!respV.ok) throw new Error(`Failed to download video track: ${respV.status}`);
      const videoBuffer = await respV.arrayBuffer();

      // Content sniffing: verify videoBuffer is not an HLS playlist starting with #EXTM3U
      const headerStr = new TextDecoder('utf-8').decode(new Uint8Array(videoBuffer.slice(0, 15)));
      if (headerStr.startsWith('#EXTM3U')) {
        const textV = new TextDecoder('utf-8').decode(videoBuffer);
        const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
        const parsedV = HLSParser.parse(textV, videoUrl);
        if (parsedV.segments && parsedV.segments.length > 0) {
          videoSegments = parsedV.segments;
          videoInitUrl = parsedV.initSegment || null;
        }
      } else {
        let audioBuffer = null;
        const directAudioUrl = audioRendition?.url || audioRendition?.uri;
        if (directAudioUrl) {
          this.reportProgress(50, 'Downloading audio track...', '');
          const respA = await fetch(directAudioUrl, { signal: this.abortController?.signal });
          if (!respA.ok) throw new Error(`Failed to download audio track: HTTP ${respA.status}`);
          audioBuffer = await respA.arrayBuffer();
        }
        if (audioRendition && (!audioBuffer || audioBuffer.byteLength === 0)) {
          throw new Error('Audio download failed: unable to fetch audio track for muxing.');
        }

        this.reportProgress(80, 'Muxing tracks (WASM)...', '');
        const muxedBlob = await WASMMuxer.mux(videoBuffer, audioBuffer, (progress) => {
          const overall = Math.round(80 + progress * 0.15);
          this.reportProgress(overall, 'Muxing tracks (WASM)...', '');
        });

        const muxedBuf = await muxedBlob.arrayBuffer();
        const val = WASMMuxer.validateMP4(new Uint8Array(muxedBuf), !!audioRendition);
        if (!val.valid) {
          throw new Error(`Generated MP4 validation failed: ${val.error}`);
        }

        let muxFilename = this.options.filename || 'download.mp4';
        muxFilename = muxFilename.replace(/\.[^.]+$/, '') + '.mp4';
        await this.triggerSave(new Blob([muxedBuf], { type: 'video/mp4' }), muxFilename);
        this.reportStatus('complete', 'Complete!');
        return;
      }
    }

    if ((!videoSegments || videoSegments.length === 0) && videoUrl) {
      this.reportProgress(6, 'Fetching video playlist...', '');
      const textV = await this.fetchPlaylist(videoUrl, referer);
      const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
      const parsedV = HLSParser.parse(textV, videoUrl);
      if (parsedV.segments && parsedV.segments.length > 0) {
        videoSegments = parsedV.segments;
        videoInitUrl = parsedV.initSegment || null;
      } else if (parsedV.variants && parsedV.variants.length > 0) {
        const vFirst = parsedV.variants[0];
        const vFirstUrl = vFirst.url || vFirst.uri;
        const vText2 = await this.fetchPlaylist(vFirstUrl, referer);
        const vParsed2 = HLSParser.parse(vText2, vFirstUrl);
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
    const audioUrl = audioRendition?.url || audioRendition?.uri;

    // If audio rendition is required, fetch audio playlist if segments or initUrl are missing
    if ((!audioSegments || audioSegments.length === 0 || !audioInitUrl) && audioUrl) {
      this.reportProgress(41, 'Fetching audio playlist...', '');
      try {
        const text = await this.fetchPlaylist(audioUrl, referer);
        const { HLSParser } = await import(chrome.runtime.getURL('lib/hls-parser.js'));
        const parsed = HLSParser.parse(text, audioUrl);
        if (parsed.segments && parsed.segments.length > 0) {
          audioSegments = parsed.segments;
          audioInitUrl = parsed.initSegment || null;
        } else if (parsed.variants && parsed.variants.length > 0) {
          const aFirst = parsed.variants[0];
          const aFirstUrl = aFirst.url || aFirst.uri;
          const aText2 = await this.fetchPlaylist(aFirstUrl, referer);
          const aParsed2 = HLSParser.parse(aText2, aFirstUrl);
          audioSegments = aParsed2.segments;
          audioInitUrl = aParsed2.initSegment || null;
        }
      } catch (aErr) {
        console.error('[MediaSniff Offscreen] Failed to fetch audio playlist:', aErr);
        throw new Error('Audio playlist fetch failed: ' + aErr.message);
      }
    }

    // Fail immediately if required audio rendition has no segments
    if (audioRendition && (!audioSegments || audioSegments.length === 0)) {
      throw new Error('Audio download failed: no audio segments found in playlist for required audio rendition.');
    }

    // Determine whether the audio rendition is MPEG-TS or fMP4/CMAF
    // Prefer playlist/container metadata, and probe first segment's magic bytes where necessary
    let isFmp4 = !!audioInitUrl;
    let isTs = false;
    let preloadedFirstSegment = null;

    const renditionContainer = (audioRendition?.container || audioRendition?.mimeType || '').toLowerCase();
    if (renditionContainer.includes('mp2t') || renditionContainer.includes('ts')) {
      isTs = true;
      isFmp4 = false;
    } else if (renditionContainer.includes('mp4') || renditionContainer.includes('cmaf')) {
      isFmp4 = true;
      isTs = false;
    }

    const audioDownloader = new SegmentDownloader({
      concurrency: 8,
      referer,
      onProgress: (p) => {
        const overall = Math.round(40 + p.percent * 0.3);
        this.reportProgress(overall, `Audio: ${p.completed}/${p.total}`, p.speedLabel);
      }
    });
    audioDownloader.abortController = this.abortController;

    // If still undetermined, probe the first segment's magic bytes
    if (!isFmp4 && !isTs && audioSegments && audioSegments.length > 0) {
      const firstSeg = audioSegments[0];
      const firstSegUrl = typeof firstSeg === 'string' ? firstSeg : firstSeg?.url;
      const firstSegByteRange = typeof firstSeg === 'object' ? (firstSeg.byteRange || firstSeg.encryption?.byteRange) : null;
      try {
        preloadedFirstSegment = await audioDownloader.fetchWithRetry(firstSegUrl, firstSegByteRange);
        if (preloadedFirstSegment && preloadedFirstSegment.byteLength >= 4) {
          const u8 = new Uint8Array(preloadedFirstSegment);
          const v = new DataView(preloadedFirstSegment);
          let b4 = '';
          if (preloadedFirstSegment.byteLength >= 8) {
            b4 = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
          }
          if (b4 === 'styp' || b4 === 'moof' || b4 === 'ftyp' || b4 === 'moov' || b4 === 'emsg' || b4 === 'prft') {
            isFmp4 = true;
            isTs = false;
          } else if (u8[0] === 0x47 || (u8[0] === 0xFF && (u8[1] & 0xF0) === 0xF0)) {
            isTs = true;
            isFmp4 = false;
          } else {
            const detected = WASMMuxer.detectFormat(preloadedFirstSegment);
            if (detected === 'mp4') {
              isFmp4 = true;
              isTs = false;
            } else {
              isTs = true;
              isFmp4 = false;
            }
          }
        }
      } catch (probeErr) {
        console.warn('[MediaSniff Offscreen] Failed probing first audio segment:', probeErr);
      }
    }

    console.log('[MediaSniff Offscreen] Audio rendition format detected:', {
      isFmp4,
      isTs,
      hasAudioInitUrl: !!audioInitUrl,
      renditionContainer
    });

    // For fMP4/CMAF audio, require #EXT-X-MAP
    if (audioRendition && isFmp4 && !audioInitUrl) {
      throw new Error('Audio initialization segment URL (EXT-X-MAP) is required but missing from fMP4/CMAF audio playlist.');
    }

    let audioBuffer = null;
    if (audioSegments && audioSegments.length > 0) {
      let audioResult = await audioDownloader.downloadAll(audioSegments, isFmp4 ? audioInitUrl : null, preloadedFirstSegment);

      // For fMP4/CMAF audio, require audioResult.init
      if (audioRendition && isFmp4 && (!audioResult || !audioResult.init || audioResult.init.byteLength === 0)) {
        throw new Error('Audio initialization segment download failed: audioResult.init is missing or empty for fMP4/CMAF audio.');
      }

      if (audioResult && audioResult.segments && audioResult.segments.length > 0) {
        const mergeFormat = isTs ? 'ts' : (isFmp4 ? 'mp4' : 'auto');
        audioBuffer = await Transmuxer.merge(audioResult.init, audioResult.segments, mergeFormat).arrayBuffer();
      }
      audioResult = null;
    }

    // For fMP4/CMAF audio, retain the existing merged-buffer moov/moof/mdat validation
    if (audioRendition && isFmp4) {
      if (!audioBuffer || audioBuffer.byteLength === 0) {
        throw new Error('Audio download failed: merged audio buffer is empty.');
      }
      const audioBoxes = WASMMuxer.parseBoxes ? WASMMuxer.parseBoxes(new Uint8Array(audioBuffer)) : [];
      const hasMoov = audioBoxes.some(b => b.type === 'moov');
      const hasMoof = audioBoxes.some(b => b.type === 'moof');
      const hasMdat = audioBoxes.some(b => b.type === 'mdat');

      console.log('[fMP4 Audio Verification]', {
        audioBytes: audioBuffer.byteLength,
        hasMoov,
        hasMoof,
        hasMdat,
        boxCount: audioBoxes.length,
        boxTypes: audioBoxes.map(b => b.type)
      });

      if (!hasMoov) {
        throw new Error('Audio buffer verification failed: missing moov box in merged audio buffer.');
      }
      if (!hasMoof || !hasMdat) {
        throw new Error('Audio buffer verification failed: missing moof or mdat fragment box in merged audio buffer.');
      }
    } else if (audioRendition && isTs) {
      if (!audioBuffer || audioBuffer.byteLength === 0) {
        throw new Error('Audio download failed: merged TS audio buffer is empty.');
      }
      console.log('[MPEG-TS Audio Verification]', {
        audioBytes: audioBuffer.byteLength,
        isTs: true
      });
    }
    console.log('[MediaSniff Mux] Final buffers:', {
      videoBytes: videoBuffer.byteLength,
      audioBytes: audioBuffer?.byteLength || 0,
      videoFormat: WASMMuxer.detectFormat(videoBuffer),
      audioFormat: audioBuffer ? WASMMuxer.detectFormat(audioBuffer) : null
    });
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
    let muxedBuffer = await muxedBlob.arrayBuffer();
    let outputFormat = WASMMuxer.detectFormat(muxedBuffer);
    if (outputFormat === 'ts') {
      try {
        const mp4Buf = await TSToMP4Converter.convertToArrayBuffer([muxedBuffer]);
        muxedBuffer = mp4Buf;
        outputFormat = 'mp4';
      } catch (convErr) {
        console.error('[MediaSniff Offscreen] TS-to-MP4 conversion in downloadMux failed:', convErr);
        throw new Error('Converting muxed TS to MP4 failed: ' + convErr.message);
      }
    }
    const val = WASMMuxer.validateMP4(new Uint8Array(muxedBuffer), !!audioRendition);
    if (!val.valid) {
      throw new Error(`Generated MP4 validation failed: ${val.error}`);
    }

    muxFilename = muxFilename.replace(/\.[^.]+$/, '') + '.mp4';
    await this.triggerSave(new Blob([muxedBuffer], { type: 'video/mp4' }), muxFilename);
    this.reportStatus('complete', 'Complete!');
  }

  getBestDirectVideoUrl(requestedQuality) {
    const directVideo = this.item.directVideoUrls;
    if (!directVideo) return null;

    // Direct match for requested quality
    const targetHeight = (String(requestedQuality).match(/\d+/) ? parseInt(String(requestedQuality).match(/\d+/)[0], 10) : 1080);
    const targetStr = String(targetHeight);

    if (directVideo[targetStr]) return directVideo[targetStr];
    if (directVideo[requestedQuality]) return directVideo[requestedQuality];

    // Find closest available quality <= requested
    const availableHeights = Object.keys(directVideo)
      .map(k => parseInt(k, 10))
      .filter(h => !isNaN(h) && h > 0)
      .sort((a, b) => b - a);

    const matchOrLower = availableHeights.find(h => h <= targetHeight);
    if (matchOrLower && directVideo[String(matchOrLower)]) {
      return directVideo[String(matchOrLower)];
    }

    // Otherwise highest available
    if (availableHeights.length > 0 && directVideo[String(availableHeights[0])]) {
      return directVideo[String(availableHeights[0])];
    }

    return directVideo['default'] || null;
  }

  getBestDirectAudioUrl(isWebm) {
    const directAudio = this.item.directAudioUrls || {};
    const itemAudio = this.item.audioUrl || this.item.audio || null;

    if (isWebm) {
      if (directAudio.webm) return directAudio.webm;
      if (directAudio.default) return directAudio.default;
      if (itemAudio) return itemAudio;
      if (directAudio.mp4) return directAudio.mp4;
    } else {
      // For MP4 video: prefer MP4/AAC audio, but fall back to WebM/Opus audio if that is all that was captured
      if (directAudio.mp4) return directAudio.mp4;
      if (directAudio.default && !directAudio.default.includes('mime=audio%2Fwebm') && !directAudio.default.includes('mime=audio/webm') && !directAudio.default.includes('itag=251') && !directAudio.default.includes('itag=250') && !directAudio.default.includes('itag=249')) {
        return directAudio.default;
      }
      if (itemAudio && !itemAudio.includes('mime=audio%2Fwebm') && !itemAudio.includes('mime=audio/webm') && !itemAudio.includes('itag=251') && !itemAudio.includes('itag=250') && !itemAudio.includes('itag=249')) {
        return itemAudio;
      }
      if (directAudio.default) return directAudio.default;
      if (itemAudio) return itemAudio;
      if (directAudio.webm) return directAudio.webm;
    }

    return null;
  }

  async downloadYouTube() {
    console.log('[YT RESOLVE] INPUT', {
      itemId: this.itemId,
      youtubeId: this.item.youtubeId,
      requestedQuality: this.options.ytQuality,
      directVideoKeys: Object.keys(this.item.directVideoUrls || {}),
      hasDirectAudio: !!this.item.directAudioUrls,
      hasRawAdaptive: !!this.item.rawAdaptiveFormats?.length,
      videoUrlPresent: !!this.item.videoUrl,
      audioUrlPresent: !!this.item.audioUrl
    });

    this.reportProgress(0, 'Preparing...', '');
    this.reportProgress(5, 'Resolving YouTube streams...', '');

    let videoUrl = null;
    let audioUrl = null;
    let isCombined = false;
    let resultFilename = this.options.filename;

    const requestedQuality = this.options.ytQuality || '1080';
    const targetHeight = (String(requestedQuality).match(/\d+/) ? parseInt(String(requestedQuality).match(/\d+/)[0], 10) : 1080);
    const targetHeightStr = String(targetHeight);

    // ─── Source 1: Direct Captured googlevideo URLs First ───
    videoUrl = this.getBestDirectVideoUrl(requestedQuality);
    if (!videoUrl && this.item.videoUrl) {
      videoUrl = this.item.videoUrl;
    }

    const isWebm = (videoUrl && (videoUrl.includes('mime=video%2Fwebm') || videoUrl.includes('mime=video/webm'))) || (this.item.mimeType && this.item.mimeType.includes('webm'));

    audioUrl = this.getBestDirectAudioUrl(isWebm);

    console.log('[YT RESOLVE] DIRECT', {
      video: !!videoUrl,
      audio: !!audioUrl
    });

    // ─── Source 2: Raw Adaptive Formats (with deciphering) ───
    if (!videoUrl || (!isCombined && !audioUrl)) {
      if (this.item.rawAdaptiveFormats && this.item.rawAdaptiveFormats.length > 0) {
        try {
          const adaptiveFormats = this.item.rawAdaptiveFormats;
          const formats = this.item.rawFormats || [];

          const hasCipher = adaptiveFormats.some(f => f.signatureCipher || f.cipher)
            || formats.some(f => f.signatureCipher || f.cipher);

          let decipher = null;
          if (hasCipher && this.item.jsUrl) {
            try {
              decipher = await YouTubeDownloader.getDecipherFunction(this.item.jsUrl);
            } catch(e) {}
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

            if (parsed.s) {
              if (decipher) {
                try {
                  const signature = decipher(parsed.s);
                  const urlObj = new URL(parsed.url);
                  urlObj.searchParams.set(parsed.sp, signature);
                  urlObj.searchParams.set('ratebypass', 'yes');
                  return urlObj.href;
                } catch (err) {
                  return null;
                }
              }
              return null;
            }
            return parsed.url;
          };

          const videoStreams = adaptiveFormats
            .filter(f => f.mimeType?.startsWith('video/') && (f.mimeType?.includes('mp4') || f.mimeType?.includes('webm')))
            .map(f => {
               try { return { ...f, resolvedUrl: resolveStreamUrl(f) }; }
               catch(e) { return { ...f, resolvedUrl: null }; }
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
               try { return { ...f, resolvedUrl: resolveStreamUrl(f) }; }
               catch(e) { return { ...f, resolvedUrl: null }; }
            })
            .filter(f => f.resolvedUrl)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

          this._resolvedVideoStreams = videoStreams;
          this._resolvedAudioStreams = audioStreams;

          if (!videoUrl && videoStreams.length > 0) {
            let bestVideo = videoStreams.find(f => (f.height || 0) <= targetHeight) || videoStreams[0];
            if (bestVideo) {
              videoUrl = bestVideo.resolvedUrl;
              const isWebmVid = bestVideo.mimeType?.includes('webm');
              const title = this.item.filename || this.item.title || 'YouTube Video';
              const defaultName = `${title}${isWebmVid ? '.webm' : '.mp4'}`;
              resultFilename = this.options.filename || defaultName;
              if (isWebmVid && !resultFilename.endsWith('.webm')) {
                resultFilename = resultFilename.replace(/\.[^.]+$/, '') + '.webm';
              }
            }
          }

          if (!audioUrl && audioStreams.length > 0) {
            const currentIsWebm = (videoUrl && (videoUrl.includes('mime=video%2Fwebm') || videoUrl.includes('mime=video/webm'))) || resultFilename?.endsWith('.webm');
            let matchedAudio = currentIsWebm
              ? audioStreams.find(a => (a.mimeType?.includes('webm') || a.mimeType?.includes('opus')) && a.resolvedUrl)
              : (audioStreams.find(a => a.mimeType?.includes('mp4') && a.resolvedUrl) || audioStreams.find(a => a.mimeType?.includes('aac') && a.resolvedUrl));

            if (matchedAudio?.resolvedUrl) {
              audioUrl = matchedAudio.resolvedUrl;
            }
          }
        } catch (err) {
          console.warn('[MediaSniff Offscreen] Direct resolution from memory registry failed:', err.message);
        }
      }
    }

    console.log('[YT RESOLVE] RAW', {
      video: !!videoUrl,
      audio: !!audioUrl
    });

    // ─── Source 3: YouTubeDownloader.getDownloadUrl Fallback ───
    if (!videoUrl || (!isCombined && !audioUrl)) {
      console.log(`[MediaSniff Offscreen] Resolution incomplete (video: ${!!videoUrl}, audio: ${!!audioUrl}), fetching via YouTubeDownloader...`);
      const targetWatchUrl = this.item.url || this.item.pageUrl || (this.item.youtubeId ? `https://www.youtube.com/watch?v=${this.item.youtubeId}` : null);
      if (targetWatchUrl) {
        try {
          const result = await YouTubeDownloader.getDownloadUrl(targetWatchUrl, targetHeightStr);
          if (result) {
            if (result.isCombined) {
              videoUrl = result.url || result.videoUrl;
              audioUrl = null;
              isCombined = true;
            } else {
              if (result.url || result.videoUrl) {
                videoUrl = result.url || result.videoUrl;
              }
              if (result.audioUrl) {
                audioUrl = result.audioUrl;
              }
            }
            if (result.filename && !resultFilename) {
              resultFilename = result.filename;
            }
          }
        } catch (fbErr) {
          console.warn('[MediaSniff Offscreen] YouTubeDownloader.getDownloadUrl error:', fbErr.message);
        }
      }

      // If the fallback returns a valid video URL but no audio URL for an adaptive stream,
      // try directAudioUrls / raw adaptive audio again before failing
      if (!isCombined && !audioUrl) {
        const isCurrentWebm = (videoUrl && (videoUrl.includes('mime=video%2Fwebm') || videoUrl.includes('mime=video/webm'))) || resultFilename?.endsWith('.webm');
        audioUrl = this.getBestDirectAudioUrl(isCurrentWebm);
        if (!audioUrl && this._resolvedAudioStreams && this._resolvedAudioStreams.length > 0) {
          const matched = isCurrentWebm
            ? this._resolvedAudioStreams.find(a => (a.mimeType?.includes('webm') || a.mimeType?.includes('opus')) && a.resolvedUrl)
            : (this._resolvedAudioStreams.find(a => a.mimeType?.includes('mp4') && a.resolvedUrl) || this._resolvedAudioStreams.find(a => a.mimeType?.includes('aac') && a.resolvedUrl));
          if (matched?.resolvedUrl) {
            audioUrl = matched.resolvedUrl;
          }
        }
      }
    }

    console.log('[YT RESOLVE] FALLBACK', {
      video: !!videoUrl,
      audio: !!audioUrl,
      isCombined
    });

    // Fallback card titles
    if (!resultFilename) {
      const title = this.item.filename || this.item.title || (this.item.youtubeId ? `YouTube Video ${this.item.youtubeId}` : 'YouTube Video');
      const isWebmFinal = (videoUrl && (videoUrl.includes('mime=video%2Fwebm') || videoUrl.includes('mime=video/webm'))) || (this.item.mimeType && this.item.mimeType.includes('webm'));
      resultFilename = `${title}${isWebmFinal ? '.webm' : '.mp4'}`;
    }

    // Re-check direct audio from item before failing
    if (!isCombined && !audioUrl) {
      const isCurrentWebm = (videoUrl && (videoUrl.includes('mime=video%2Fwebm') || videoUrl.includes('mime=video/webm'))) || resultFilename?.endsWith('.webm');
      audioUrl = this.getBestDirectAudioUrl(isCurrentWebm);
      if (!audioUrl) {
        audioUrl = this.item.directAudioUrls?.mp4 || this.item.directAudioUrls?.default || this.item.directAudioUrls?.webm || this.item.audioUrl || null;
      }
    }

    // Direct combined format fallback from rawFormats if audio is still missing
    if (!isCombined && !audioUrl && this.item.rawFormats?.length > 0) {
      const directCombined = this.item.rawFormats.find(f => f.url && !f.signatureCipher && !f.cipher);
      if (directCombined?.url) {
        videoUrl = directCombined.url;
        audioUrl = null;
        isCombined = true;
        console.log('[MediaSniff Offscreen] Falling back to direct combined format from rawFormats:', directCombined.itag);
      }
    }

    // Validate URLs before starting downloads
    if (!videoUrl) {
      throw new Error('Unable to resolve YouTube video stream: no usable direct, adaptive, or fallback video URL was found.');
    }
    if (!isCombined && !audioUrl) {
      console.log('[YT AUDIO FINAL INPUT]', {
        directAudioKeys: Object.keys(this.item.directAudioUrls || {}),
        directMp4: !!this.item.directAudioUrls?.mp4,
        directWebm: !!this.item.directAudioUrls?.webm,
        directDefault: !!this.item.directAudioUrls?.default,
        itemAudioUrl: !!this.item.audioUrl,
        resolvedAudioCount: this._resolvedAudioStreams?.length || 0
      });

      throw new Error(
        'Unable to resolve YouTube audio stream: no compatible captured or adaptive audio URL exists.'
      );
    }

    console.log('[YT AUDIO FINAL INPUT]', {
      directAudioKeys: Object.keys(this.item.directAudioUrls || {}),
      directMp4: !!this.item.directAudioUrls?.mp4,
      directWebm: !!this.item.directAudioUrls?.webm,
      directDefault: !!this.item.directAudioUrls?.default,
      itemAudioUrl: !!this.item.audioUrl,
      resolvedAudioCount: this._resolvedAudioStreams?.length || 0
    });

    console.log('[YT RESOLVED STREAMS]', {
      videoUrl: !!videoUrl,
      audioUrl: !!audioUrl,
      isCombined
    });

    this.reportProgress(10, 'Video URL resolved', '');
    if (!isCombined && audioUrl) {
      this.reportProgress(15, 'Audio URL resolved', '');
    }

    // ─── Download and Mux Pipeline ───
    let finalBlob;

    if (isCombined) {
      // Combined stream: download directly (20% to 95%)
      this.reportProgress(20, 'Downloading from YouTube...', '');
      finalBlob = await YouTubeDownloader.downloadStream(
        videoUrl,
        (p) => {
          const overall = Math.round(20 + p.percent * 0.75); // 20% to 95%
          this.reportProgress(overall, `Downloading: ${p.sizeLabel}`, p.speedLabel);
        },
        this.abortController.signal
      );
    } else {
      // Adaptive stream: download video (20% to 50%) and audio (50% to 80%)
      this.reportProgress(20, 'Downloading video stream...', '');
      const videoBlob = await YouTubeDownloader.downloadStream(
        videoUrl,
        (p) => {
          const overall = Math.round(20 + p.percent * 0.30); // 20% to 50%
          this.reportProgress(overall, `Video: ${p.sizeLabel}`, p.speedLabel);
        },
        this.abortController.signal
      );

      this.reportProgress(50, 'Downloading audio stream...', '');
      let audioBlob = null;
      try {
        audioBlob = await YouTubeDownloader.downloadStream(
          audioUrl,
          (p) => {
            const overall = Math.round(50 + p.percent * 0.30); // 50% to 80%
            this.reportProgress(overall, `Audio: ${p.sizeLabel}`, p.speedLabel);
          },
          this.abortController.signal
        );
      } catch (audioErr) {
        console.error('[MediaSniff YouTube] Audio stream download failed:', audioErr);
        throw new Error('Audio download failed: ' + audioErr.message);
      }

      if (!audioBlob || audioBlob.size === 0) {
        throw new Error('YouTube audio download failed.');
      }

      this.reportProgress(80, 'Muxing tracks...', '');
      const videoBuffer = await videoBlob.arrayBuffer();
      const audioBuffer = await audioBlob.arrayBuffer();

      const videoFormat = WASMMuxer.detectFormat(videoBuffer);
      const audioFormat = WASMMuxer.detectFormat(audioBuffer);

      console.log('[MediaSniff YouTube] Final buffers:', {
        videoBytes: videoBuffer.byteLength,
        audioBytes: audioBuffer.byteLength,
        videoFormat,
        audioFormat
      });

      if (!audioBuffer || audioBuffer.byteLength === 0) {
        throw new Error('Audio buffer is empty. Cannot produce a valid video with audio.');
      }

      // Try native companion muxing if available
      try {
        const nativeResult = await this.triggerNativeDownload(
          videoUrl,
          audioUrl,
          resultFilename
        );
        if (nativeResult && (nativeResult.status === 'complete' || nativeResult.success)) {
          this.reportStatus('complete', nativeResult.statusLabel || 'Complete!');
          return;
        }
      } catch (_) {}

      if (videoFormat === 'mp4' && audioFormat === 'webm') {
        throw new Error('Incompatible audio container (received WebM audio for MP4 video container). Please install/connect the Companion App to mux MP4 video with WebM audio.');
      }

      // In-browser WASM Mux (82% to 95%)
      this.reportProgress(82, 'Remuxing tracks (WASM)...', '');
      try {
        const muxedBlob = await WASMMuxer.mux(videoBuffer, audioBuffer, (progress) => {
          const overall = Math.round(82 + progress * 0.13); // 82% to 95%
          this.reportProgress(overall, 'Remuxing tracks (WASM)...', '');
        });
        finalBlob = muxedBlob;
      } catch (muxErr) {
        console.error('[MediaSniff YouTube] WASM muxing failed:', muxErr);
        throw new Error('Muxing video and audio tracks failed: ' + muxErr.message);
      }
    }

    // ─── 95% Validating output MP4 (Section I) ───
    this.reportProgress(95, 'Validating output MP4...', '');
    const finalBuffer = await finalBlob.arrayBuffer();
    const finalFormat = WASMMuxer.detectFormat(finalBuffer);
    if (finalFormat === 'mp4') {
      const val = WASMMuxer.validateMP4(new Uint8Array(finalBuffer), !isCombined);
      if (!val.valid) {
        throw new Error(`Generated MP4 validation failed: ${val.error}`);
      }
    }

    // ─── 100% Saving ───
    this.reportProgress(98, 'Saving video...', '');
    await this.triggerSave(finalBlob, resultFilename);
    this.reportStatus('complete', 'Complete!');
  }
  triggerNativeDownload(videoUrl, audioUrl, filename) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'TRIGGER_NATIVE_MUX',
        itemId: this.itemId,
        videoUrl,
        audioUrl,
        filename
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.success) {
          resolve({ status: "complete", statusLabel: response.statusLabel });
        } else {
          reject(new Error(response?.error || 'Native muxing failed'));
        }
      });
    });
  }



  async triggerSave(blob, filename) {
    const url = URL.createObjectURL(blob);
    const sanitized = sanitizeFilename(filename, '.mp4');

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
    console.log('[MediaSniff Offscreen] START_BACKGROUND_DOWNLOAD received:', { itemId, downloadType, options });
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

function sanitizeFilename(rawName, fallbackExt = '') {
  if (!rawName || typeof rawName !== 'string') {
    return fallbackExt ? `download${fallbackExt.startsWith('.') ? fallbackExt : '.' + fallbackExt}` : null;
  }

  // Trim whitespace and trailing dots from input
  const raw = rawName.trim().replace(/^[\s.]+|[\s.]+$/g, '');
  if (!raw) {
    return fallbackExt ? `download${fallbackExt.startsWith('.') ? fallbackExt : '.' + fallbackExt}` : null;
  }

  let ext = '';
  let stem = raw;

  // Match known media/subtitle extensions or generic 2-5 letter extension
  const extMatch = stem.match(/\.(mp4|webm|m4a|mkv|ts|m4s|mp3|vtt|srt|aac|flv)$/i)
    || stem.match(/\.([a-zA-Z0-9]{2,5})$/i);

  if (extMatch) {
    ext = extMatch[0].toLowerCase();
    stem = stem.slice(0, -extMatch[0].length);
  } else if (fallbackExt) {
    ext = fallbackExt.startsWith('.') ? fallbackExt.toLowerCase() : '.' + fallbackExt.toLowerCase();
  }

  // Sanitize the stem
  let cleanStem = stem
    .replace(/_/g, ' ')
    .replace(/&/g, 'and')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');

  const reservedRegex = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (!cleanStem || reservedRegex.test(cleanStem)) {
    cleanStem = cleanStem ? `${cleanStem}_media` : 'download';
  }

  if (cleanStem.length > 120) {
    cleanStem = cleanStem.slice(0, 120).replace(/[\s.]+$/, '');
  }

  if (!cleanStem) {
    cleanStem = 'download';
  }

  return `${cleanStem}${ext}`;
}