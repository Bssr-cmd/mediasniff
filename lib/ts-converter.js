/**
 * MediaSniff — MPEG-TS to MP4 In-Browser Transmuxer
 * Demuxes MPEG-TS transport stream packets (H.264 video + AAC audio)
 * and remuxes them into a standard ISO BMFF MP4 container (.mp4).
 * 
 * High-performance, streaming, zero-copy Blob assembly.
 * Works 100% in-browser without external native dependencies.
 */

export class TSToMP4Converter {
  /**
   * Convert MPEG-TS segment buffers to a valid MP4 Blob
   * @param {ArrayBuffer[]|ArrayBuffer|Uint8Array} segments - Input TS segments
   * @param {Function} onProgress - Progress callback (0 to 1)
   * @returns {Blob} MP4 Blob (video/mp4)
   */
  static convert(segments, onProgress = () => {}) {
    onProgress(0.05);

    // Normalize input to array of Uint8Arrays
    let segArrays = [];
    if (Array.isArray(segments)) {
      segArrays = segments.map(s => s instanceof Uint8Array ? s : new Uint8Array(s));
    } else if (segments instanceof Uint8Array) {
      segArrays = [segments];
    } else if (segments instanceof ArrayBuffer) {
      segArrays = [new Uint8Array(segments)];
    }

    if (segArrays.length === 0 || segArrays[0].length === 0) {
      throw new Error('No TS data provided for conversion');
    }

    // ─── Step 1: Demux TS Packets & Assemble PES ─────────────────
    onProgress(0.15);
    const { videoPes, audioPes, sps, pps } = TSToMP4Converter.demuxTS(segArrays);

    if (videoPes.length === 0 && audioPes.length === 0) {
      throw new Error('No video or audio streams found in TS data');
    }

    // ─── Step 2: Extract Video Samples (H.264) ───────────────────
    onProgress(0.40);
    const videoData = videoPes.length > 0 
      ? TSToMP4Converter.parseVideoPes(videoPes, sps, pps)
      : null;

    // Free raw video PES memory early to minimize peak heap footprint
    videoPes.length = 0;

    // ─── Step 3: Extract Audio Samples (AAC) ─────────────────────
    onProgress(0.60);
    const audioData = audioPes.length > 0 
      ? TSToMP4Converter.parseAudioPes(audioPes)
      : null;

    // Free raw audio PES memory early
    audioPes.length = 0;

    // ─── Step 4: Build MP4 Blob with Zero-Copy Sample Assembly ────
    onProgress(0.80);
    const blob = TSToMP4Converter.buildMP4Blob(videoData, audioData);

    onProgress(1.0);
    return blob;
  }

  /**
   * Convert MPEG-TS segment buffers to an ArrayBuffer
   * @param {ArrayBuffer[]|ArrayBuffer|Uint8Array} segments - Input TS segments
   * @param {Function} onProgress - Progress callback (0 to 1)
   * @returns {Promise<ArrayBuffer>} MP4 ArrayBuffer
   */
  static async convertToArrayBuffer(segments, onProgress = () => {}) {
    const blob = TSToMP4Converter.convert(segments, onProgress);
    return await blob.arrayBuffer();
  }

  /**
   * Demux TS packets from segments into Video & Audio PES packets
   * Automatically aligns to 0x47 sync bytes across ID3 headers or segment padding.
   */
  static demuxTS(segArrays) {
    let pmtPid = null;
    let videoPid = null;
    let audioPid = null;

    // 1. Scan for PAT & PMT to identify stream PIDs
    for (const seg of segArrays) {
      const len = seg.length;
      let sync = 0;
      while (sync + 188 <= len) {
        if (seg[sync] === 0x47 && (sync + 188 === len || seg[sync + 188] === 0x47)) break;
        sync++;
      }

      for (let i = sync; i + 188 <= len; i += 188) {
        if (seg[i] !== 0x47) continue;

        const pid = ((seg[i + 1] & 0x1F) << 8) | seg[i + 2];
        const pusi = (seg[i + 1] >> 6) & 1;
        const afc = (seg[i + 3] >> 4) & 3;

        let offset = 4;
        if (afc & 2) offset += 1 + seg[i + 4];
        if (offset >= 188 || !(afc & 1)) continue;

        if (pid === 0 && pmtPid === null) {
          // PAT
          let p = offset;
          if (pusi) p += 1 + seg[i + p];
          if (p + 3 <= 188) {
            const secLen = ((seg[i + p + 1] & 0x0F) << 8) | seg[i + p + 2];
            const end = p + 3 + secLen - 4;
            p += 8;
            while (p + 4 <= end && p + 4 <= 188) {
              const progNum = (seg[i + p] << 8) | seg[i + p + 1];
              const pPid = ((seg[i + p + 2] & 0x1F) << 8) | seg[i + p + 3];
              if (progNum !== 0) {
                pmtPid = pPid;
                break;
              }
              p += 4;
            }
          }
        } else if (pmtPid !== null && pid === pmtPid && (videoPid === null || audioPid === null)) {
          // PMT
          let p = offset;
          if (pusi) p += 1 + seg[i + p];
          if (p + 12 <= 188) {
            const secLen = ((seg[i + p + 1] & 0x0F) << 8) | seg[i + p + 2];
            const progInfoLen = ((seg[i + p + 10] & 0x0F) << 8) | seg[i + p + 11];
            let ep = p + 12 + progInfoLen;
            const end = p + 3 + secLen - 4;
            while (ep + 5 <= end && ep + 5 <= 188) {
              const streamType = seg[i + ep];
              const elemPid = ((seg[i + ep + 1] & 0x1F) << 8) | seg[i + ep + 2];
              const esInfoLen = ((seg[i + ep + 3] & 0x0F) << 8) | seg[i + ep + 4];
              // 0x1B: H.264, 0x24: HEVC, 0x02: MPEG-2 Video
              if ((streamType === 0x1B || streamType === 0x24 || streamType === 0x02) && videoPid === null) {
                videoPid = elemPid;
              } else if ([0x0F, 0x03, 0x04, 0x06, 0x11, 0x80, 0x81, 0x87].includes(streamType) && audioPid === null) {
                audioPid = elemPid;
              }
              ep += 5 + esInfoLen;
            }
          }
        }
      }
      if (videoPid !== null && audioPid !== null) break;
    }

    // Fallback: auto-detect PIDs if PAT/PMT not present
    if (videoPid === null || audioPid === null) {
      for (const seg of segArrays) {
        const len = seg.length;
        let sync = 0;
        while (sync + 188 <= len) {
          if (seg[sync] === 0x47 && (sync + 188 === len || seg[sync + 188] === 0x47)) break;
          sync++;
        }

        for (let i = sync; i + 188 <= len; i += 188) {
          if (seg[i] !== 0x47) continue;
          const pusi = (seg[i + 1] >> 6) & 1;
          if (!pusi) continue;
          const pid = ((seg[i + 1] & 0x1F) << 8) | seg[i + 2];
          const afc = (seg[i + 3] >> 4) & 3;
          let offset = 4;
          if (afc & 2) offset += 1 + seg[i + 4];
          if (offset + 4 <= 188 && seg[i + offset] === 0x00 && seg[i + offset + 1] === 0x00 && seg[i + offset + 2] === 0x01) {
            const streamId = seg[i + offset + 3];
            if (videoPid === null && streamId >= 0xE0 && streamId <= 0xEF) videoPid = pid;
            else if (audioPid === null && ((streamId >= 0xC0 && streamId <= 0xDF) || streamId === 0xBD)) audioPid = pid;
          }
        }
      }
    }

    if (videoPid === null) videoPid = 0x100;
    if (audioPid === null) audioPid = 0x101;

    // 2. Reassemble PES packets across segments
    const videoPes = [];
    const audioPes = [];
    let vChunks = [];
    let aChunks = [];
    let sps = null;
    let pps = null;

    const flushPes = (chunks, list) => {
      if (chunks.length === 0) return;
      let total = 0;
      for (let c = 0; c < chunks.length; c++) total += chunks[c].length;
      const merged = new Uint8Array(total);
      let off = 0;
      for (let c = 0; c < chunks.length; c++) {
        merged.set(chunks[c], off);
        off += chunks[c].length;
      }
      list.push(merged);
    };

    for (const seg of segArrays) {
      const len = seg.length;
      let sync = 0;
      while (sync + 188 <= len) {
        if (seg[sync] === 0x47 && (sync + 188 === len || seg[sync + 188] === 0x47)) break;
        sync++;
      }

      for (let i = sync; i + 188 <= len; i += 188) {
        if (seg[i] !== 0x47) continue;

        const pid = ((seg[i + 1] & 0x1F) << 8) | seg[i + 2];
        const pusi = (seg[i + 1] >> 6) & 1;
        const afc = (seg[i + 3] >> 4) & 3;

        let offset = 4;
        if (afc & 2) offset += 1 + seg[i + 4];
        if (offset >= 188 || !(afc & 1)) continue;

        const payload = seg.subarray(i + offset, i + 188);

        if (pid === videoPid) {
          if (pusi && vChunks.length > 0) {
            flushPes(vChunks, videoPes);
            vChunks = [];
          }
          vChunks.push(payload);
        } else if (pid === audioPid) {
          if (pusi && aChunks.length > 0) {
            flushPes(aChunks, audioPes);
            aChunks = [];
          }
          aChunks.push(payload);
        }
      }
    }

    if (vChunks.length > 0) flushPes(vChunks, videoPes);
    if (aChunks.length > 0) flushPes(aChunks, audioPes);

    return { videoPes, audioPes, sps, pps };
  }

  /**
   * Parse Video PES packets to extract H.264 NAL units & sample timings
   */
  static parseVideoPes(videoPes, initialSps, initialPps) {
    let sps = initialSps;
    let pps = initialPps;
    const samples = [];

    for (const pes of videoPes) {
      if (pes.length < 9) continue;
      if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) continue;

      const { pts, dts } = TSToMP4Converter.parsePtsDts(pes);
      const hdrLen = pes[8];
      if (9 + hdrLen >= pes.length) continue;
      const data = pes.subarray(9 + hdrLen);

      // Find NAL units via start codes 00 00 00 01 or 00 00 01
      const nalStarts = [];
      const dLen = data.length;
      for (let i = 0; i + 3 < dLen; i++) {
        if (data[i] === 0x00 && data[i + 1] === 0x00) {
          if (data[i + 2] === 0x01) {
            nalStarts.push(i);
            i += 2;
          } else if (data[i + 2] === 0x00 && i + 3 < dLen && data[i + 3] === 0x01) {
            nalStarts.push(i);
            i += 3;
          }
        }
      }

      if (nalStarts.length === 0) continue;

      const sampleNals = [];
      let isKeyframe = false;

      for (let idx = 0; idx < nalStarts.length; idx++) {
        const s = nalStarts[idx];
        const is4Byte = (data[s] === 0 && data[s + 1] === 0 && data[s + 2] === 0 && data[s + 3] === 1);
        const prefix = is4Byte ? 4 : 3;
        const end = idx + 1 < nalStarts.length ? nalStarts[idx + 1] : dLen;
        const nal = data.subarray(s + prefix, end);
        if (nal.length === 0) continue;

        const ntype = nal[0] & 0x1F;
        if (ntype === 7 && !sps) sps = nal;
        else if (ntype === 8 && !pps) pps = nal;
        else if (ntype === 5) isKeyframe = true;

        // Keep all NAL units in sample data (AUD, SPS, PPS, SEI, slices)
        sampleNals.push(nal);
      }

      if (sampleNals.length > 0) {
        // Format as 4-byte length-prefixed NALUs (AVC format)
        let totalBytes = 0;
        for (let n = 0; n < sampleNals.length; n++) totalBytes += 4 + sampleNals[n].length;
        const sampleData = new Uint8Array(totalBytes);
        const view = new DataView(sampleData.buffer);
        let sOff = 0;
        for (let n = 0; n < sampleNals.length; n++) {
          const nal = sampleNals[n];
          view.setUint32(sOff, nal.length);
          sampleData.set(nal, sOff + 4);
          sOff += 4 + nal.length;
        }

        samples.push({
          data: sampleData,
          pts,
          dts: dts !== null ? dts : pts,
          sync: isKeyframe
        });
      }
    }

    if (samples.length === 0) return null;

    // Normalize timestamps relative to first frame
    const baseDts = samples[0].dts !== null ? samples[0].dts : (samples[0].pts || 0);
    for (const s of samples) {
      s.dts = Math.max(0, s.dts - baseDts);
      s.pts = Math.max(0, s.pts - baseDts);
    }

    // Calculate frame durations with smoothing for timestamp jitter
    for (let i = 0; i < samples.length; i++) {
      if (i + 1 < samples.length) {
        const diff = samples[i + 1].dts - samples[i].dts;
        samples[i].duration = (diff > 0 && diff < 90000) ? diff : (i > 0 ? samples[i - 1].duration : 3600);
      } else {
        samples[i].duration = i > 0 ? samples[i - 1].duration : 3600;
      }
    }

    // Parse SPS width & height
    let width = 1280;
    let height = 720;
    if (sps) {
      try {
        const dims = TSToMP4Converter.parseSPS(sps);
        width = dims.width || width;
        height = dims.height || height;
      } catch (_) {}
    }

    return { samples, sps, pps, width, height, timescale: 90000 };
  }

  /**
   * Parse Audio PES packets to extract AAC raw frames & sample timings
   */
  static parseAudioPes(audioPes) {
    const samples = [];
    let sampleRate = 44100;
    let channels = 2;
    let profile = 2; // AAC-LC
    const rateIndices = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

    for (const pes of audioPes) {
      if (pes.length < 9) continue;
      if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) continue;

      const { pts } = TSToMP4Converter.parsePtsDts(pes);
      const hdrLen = pes[8];
      if (9 + hdrLen >= pes.length) continue;
      
      const pesLen = (pes[4] << 8) | pes[5];
      const maxDataLen = pesLen > 0 ? Math.min(pes.length - (9 + hdrLen), Math.max(0, (6 + pesLen) - (9 + hdrLen))) : pes.length - (9 + hdrLen);
      const data = pes.subarray(9 + hdrLen, 9 + hdrLen + maxDataLen);
      const dLen = data.length;

      let i = 0;
      while (i + 7 <= dLen) {
        if (data[i] === 0xFF && (data[i + 1] & 0xF0) === 0xF0) {
          const hasCrc = (data[i + 1] & 1) === 0;
          const adtsHdrLen = hasCrc ? 9 : 7;
          profile = ((data[i + 2] >> 6) & 3) + 1;
          const freqIdx = (data[i + 2] >> 2) & 0x0F;
          if (freqIdx < rateIndices.length) sampleRate = rateIndices[freqIdx];
          channels = ((data[i + 2] & 1) << 2) | ((data[i + 3] >> 6) & 3);
          const frameLen = ((data[i + 3] & 3) << 11) | (data[i + 4] << 3) | ((data[i + 5] >> 5) & 7);

          if (frameLen <= adtsHdrLen || i + frameLen > dLen) break;
          const rawAac = data.slice(i + adtsHdrLen, i + frameLen);
          samples.push({
            data: rawAac,
            pts,
            duration: 1024
          });
          i += frameLen;
        } else {
          i++;
        }
      }
    }

    if (samples.length === 0) return null;
    return { samples, sampleRate, channels, profile };
  }

  /**
   * Helper: Parse PTS and DTS from PES header (90kHz timescale)
   * Uses arithmetic multiplication to avoid 32-bit signed integer bitshift overflow.
   */
  static parsePtsDts(pes) {
    const flags = (pes[7] >> 6) & 3;
    let pts = 0;
    let dts = null;

    if (flags & 2) {
      pts = ((pes[9] & 0x0E) * 536870912) +
            ((pes[10] & 0xFF) * 4194304) +
            ((pes[11] & 0xFE) * 16384) +
            ((pes[12] & 0xFF) * 128) +
            (pes[13] >> 1);
      dts = pts;
    }
    if (flags === 3) {
      dts = ((pes[14] & 0x0E) * 536870912) +
            ((pes[15] & 0xFF) * 4194304) +
            ((pes[16] & 0xFE) * 16384) +
            ((pes[17] & 0xFF) * 128) +
            (pes[18] >> 1);
    }
    return { pts, dts };
  }

  /**
   * Exp-Golomb decoder to extract width/height from H.264 SPS
   */
  static parseSPS(sps) {
    let byteIdx = 1;
    let bitIdx = 0;

    const readBit = () => {
      if (byteIdx >= sps.length) return 0;
      const b = (sps[byteIdx] >> (7 - bitIdx)) & 1;
      bitIdx++;
      if (bitIdx === 8) {
        bitIdx = 0;
        byteIdx++;
        // Skip emulation prevention bytes 0x00 0x00 0x03
        if (byteIdx < sps.length - 2 && sps[byteIdx - 1] === 0x00 && sps[byteIdx] === 0x00 && sps[byteIdx + 1] === 0x03) {
          byteIdx++;
        }
      }
      return b;
    };

    const readBits = (n) => {
      let val = 0;
      for (let i = 0; i < n; i++) val = (val << 1) | readBit();
      return val;
    };

    const readUE = () => {
      let zeros = 0;
      while (readBit() === 0 && zeros < 32) zeros++;
      if (zeros === 0) return 0;
      return (1 << zeros) - 1 + readBits(zeros);
    };

    const readSE = () => {
      const v = readUE();
      return Math.floor((v + 1) / 2) * ((v & 1) === 0 ? -1 : 1);
    };

    const profileIdc = readBits(8);
    readBits(16); // compat + level
    readUE(); // sps_id

    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      const chromaIdc = readUE();
      if (chromaIdc === 3) readBit();
      readUE(); // bit_depth_luma_minus8
      readUE(); // bit_depth_chroma_minus8
      readBit(); // qpprime_y_zero_transform_bypass_flag
      if (readBit()) { // seq_scaling_matrix_present_flag
        const count = chromaIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (readBit()) {
            const size = i < 6 ? 16 : 64;
            let last = 8, next = 8;
            for (let j = 0; j < size; j++) {
              if (next !== 0) {
                const delta = readSE();
                next = (last + delta + 256) % 256;
              }
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }

    readUE(); // log2_max_frame_num_minus4
    const pocType = readUE();
    if (pocType === 0) {
      readUE();
    } else if (pocType === 1) {
      readBit(); readSE(); readSE();
      const numRef = readUE();
      for (let i = 0; i < numRef; i++) readSE();
    }
    readUE(); // max_num_ref_frames
    readBit(); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbs = readUE() + 1;
    const picHeightInMapUnits = readUE() + 1;
    const frameMbsOnly = readBit();
    if (!frameMbsOnly) readBit();
    readBit(); // direct_8x8_inference_flag

    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (readBit()) { // frame_cropping_flag
      cropLeft = readUE();
      cropRight = readUE();
      cropTop = readUE();
      cropBottom = readUE();
    }

    const width = picWidthInMbs * 16 - (cropLeft + cropRight) * 2;
    const height = (2 - frameMbsOnly) * picHeightInMapUnits * 16 - (cropTop + cropBottom) * 2;
    return { width, height, profile: profileIdc };
  }

  // ─── Step 4: ISO BMFF Box Builders ───────────────────────────

  static box(type, payload) {
    const len = 8 + payload.length;
    const b = new Uint8Array(len);
    const view = new DataView(b.buffer);
    view.setUint32(0, len);
    b[4] = type.charCodeAt(0);
    b[5] = type.charCodeAt(1);
    b[6] = type.charCodeAt(2);
    b[7] = type.charCodeAt(3);
    b.set(payload, 8);
    return b;
  }

  static fullBox(type, version, flags, payload) {
    const p = new Uint8Array(4 + payload.length);
    const view = new DataView(p.buffer);
    view.setUint32(0, (version << 24) | (flags & 0xFFFFFF));
    p.set(payload, 4);
    return TSToMP4Converter.box(type, p);
  }

  static concat(arrays) {
    let total = 0;
    for (let i = 0; i < arrays.length; i++) total += arrays[i].length;
    const res = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < arrays.length; i++) {
      res.set(arrays[i], off);
      off += arrays[i].length;
    }
    return res;
  }

  /**
   * Builds the moov box. When baseMdatOffset > 0, populates stco/co64 with real offsets.
   */
  static buildMoov(videoData, audioData, baseMdatOffset = 0, is64Bit = false) {
    const rateIndices = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const mvhdTimescale = 1000;

    const totalVDur = videoData ? videoData.samples.reduce((a, s) => a + s.duration, 0) : 0;
    const totalADur = audioData ? audioData.samples.length * 1024 : 0;

    const scaledVDur = videoData ? Math.floor(totalVDur * (mvhdTimescale / videoData.timescale)) : 0;
    const scaledADur = audioData ? Math.floor(totalADur * (mvhdTimescale / audioData.sampleRate)) : 0;
    const maxDur = Math.max(scaledVDur, scaledADur);

    // Matrix
    const matrix = new Uint8Array(36);
    const mview = new DataView(matrix.buffer);
    mview.setUint32(0, 0x00010000);
    mview.setUint32(16, 0x00010000);
    mview.setUint32(32, 0x40000000);

    const dinf = TSToMP4Converter.box('dinf',
      TSToMP4Converter.fullBox('dref', 0, 0,
        TSToMP4Converter.concat([
          new Uint8Array([0, 0, 0, 1]),
          TSToMP4Converter.fullBox('url ', 0, 1, new Uint8Array(0))
        ])
      )
    );

    // 1. Video trak
    let trakV = null;
    let vMdatTotal = 0;
    if (videoData) {
      const { samples, sps, pps, width, height, timescale } = videoData;
      for (let i = 0; i < samples.length; i++) vMdatTotal += samples[i].data.length;

      // avcC
      const spsLen = sps ? sps.length : 0;
      const ppsLen = pps ? pps.length : 0;
      const isHighProfile = sps && [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(sps[1]);
      const avcExtraLen = isHighProfile ? 4 : 0;

      const avcCLen = 8 + spsLen + 3 + ppsLen + avcExtraLen;
      const avcC = new Uint8Array(avcCLen);
      const avcView = new DataView(avcC.buffer);
      avcC[0] = 1;
      avcC[1] = sps ? sps[1] : 0x42;
      avcC[2] = sps ? sps[2] : 0x00;
      avcC[3] = sps ? sps[3] : 0x1E;
      avcC[4] = 0xFF;
      avcC[5] = 0xE1;
      avcView.setUint16(6, spsLen);
      if (sps) avcC.set(sps, 8);
      let ppsOff = 8 + spsLen;
      avcC[ppsOff] = 1;
      avcView.setUint16(ppsOff + 1, ppsLen);
      if (pps) avcC.set(pps, ppsOff + 3);
      if (isHighProfile) {
        const extraOff = ppsOff + 3 + ppsLen;
        avcC[extraOff] = 0xFD;
        avcC[extraOff + 1] = 0xF8;
        avcC[extraOff + 2] = 0xF8;
        avcC[extraOff + 3] = 0x00;
      }
      const avcCBox = TSToMP4Converter.box('avcC', avcC);

      // avc1 sample entry (78 bytes before avcC)
      const avc1Payload = new Uint8Array(78 + avcCBox.length);
      const avc1View = new DataView(avc1Payload.buffer);
      avc1View.setUint16(6, 1);
      avc1View.setUint16(24, width);
      avc1View.setUint16(26, height);
      avc1View.setUint32(28, 0x00480000);
      avc1View.setUint32(32, 0x00480000);
      avc1View.setUint16(40, 1);
      avc1View.setUint16(74, 0x0018);
      avc1View.setInt16(76, -1);
      avc1Payload.set(avcCBox, 78);
      const avc1Box = TSToMP4Converter.box('avc1', avc1Payload);

      const stsdV = TSToMP4Converter.fullBox('stsd', 0, 0,
        TSToMP4Converter.concat([new Uint8Array([0, 0, 0, 1]), avc1Box])
      );

      // stts
      const sttsEntries = [];
      for (const s of samples) {
        if (sttsEntries.length > 0 && sttsEntries[sttsEntries.length - 1].dur === s.duration) {
          sttsEntries[sttsEntries.length - 1].count++;
        } else {
          sttsEntries.push({ count: 1, dur: s.duration });
        }
      }
      const sttsPayload = new Uint8Array(4 + sttsEntries.length * 8);
      const sttsView = new DataView(sttsPayload.buffer);
      sttsView.setUint32(0, sttsEntries.length);
      for (let i = 0; i < sttsEntries.length; i++) {
        sttsView.setUint32(4 + i * 8, sttsEntries[i].count);
        sttsView.setUint32(8 + i * 8, sttsEntries[i].dur);
      }
      const sttsV = TSToMP4Converter.fullBox('stts', 0, 0, sttsPayload);

      // stss
      const syncIndices = [];
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].sync) syncIndices.push(i + 1);
      }
      if (syncIndices.length === 0) syncIndices.push(1);
      const stssPayload = new Uint8Array(4 + syncIndices.length * 4);
      const stssView = new DataView(stssPayload.buffer);
      stssView.setUint32(0, syncIndices.length);
      for (let i = 0; i < syncIndices.length; i++) {
        stssView.setUint32(4 + i * 4, syncIndices[i]);
      }
      const stssV = TSToMP4Converter.fullBox('stss', 0, 0, stssPayload);

      // ctts
      const hasCtts = samples.some(s => s.pts !== s.dts);
      let cttsV = new Uint8Array(0);
      if (hasCtts) {
        const cttsEntries = [];
        for (const s of samples) {
          const diff = s.pts - s.dts;
          if (cttsEntries.length > 0 && cttsEntries[cttsEntries.length - 1].diff === diff) {
            cttsEntries[cttsEntries.length - 1].count++;
          } else {
            cttsEntries.push({ count: 1, diff });
          }
        }
        const cttsPayload = new Uint8Array(4 + cttsEntries.length * 8);
        const cttsView = new DataView(cttsPayload.buffer);
        cttsView.setUint32(0, cttsEntries.length);
        for (let i = 0; i < cttsEntries.length; i++) {
          cttsView.setUint32(4 + i * 8, cttsEntries[i].count);
          cttsView.setInt32(8 + i * 8, cttsEntries[i].diff);
        }
        const hasNegativeDiff = cttsEntries.some(e => e.diff < 0);
        cttsV = TSToMP4Converter.fullBox('ctts', hasNegativeDiff ? 1 : 0, 0, cttsPayload);
      }

      // stsc (1 sample per chunk)
      const stscPayload = new Uint8Array(16);
      const stscView = new DataView(stscPayload.buffer);
      stscView.setUint32(0, 1);
      stscView.setUint32(4, 1);
      stscView.setUint32(8, 1);
      stscView.setUint32(12, 1);
      const stscV = TSToMP4Converter.fullBox('stsc', 0, 0, stscPayload);

      // stsz
      const stszPayload = new Uint8Array(8 + samples.length * 4);
      const stszView = new DataView(stszPayload.buffer);
      stszView.setUint32(0, 0);
      stszView.setUint32(4, samples.length);
      for (let i = 0; i < samples.length; i++) {
        stszView.setUint32(8 + i * 4, samples[i].data.length);
      }
      const stszV = TSToMP4Converter.fullBox('stsz', 0, 0, stszPayload);

      // stco / co64: populated directly with baseMdatOffset
      let stcoV;
      if (!is64Bit) {
        const stcoPayload = new Uint8Array(4 + samples.length * 4);
        const stcoView = new DataView(stcoPayload.buffer);
        stcoView.setUint32(0, samples.length);
        if (baseMdatOffset > 0) {
          let curr = baseMdatOffset;
          for (let i = 0; i < samples.length; i++) {
            stcoView.setUint32(4 + i * 4, curr);
            curr += samples[i].data.length;
          }
        }
        stcoV = TSToMP4Converter.fullBox('stco', 0, 0, stcoPayload);
      } else {
        const co64Payload = new Uint8Array(4 + samples.length * 8);
        const co64View = new DataView(co64Payload.buffer);
        co64View.setUint32(0, samples.length);
        if (baseMdatOffset > 0) {
          let curr = BigInt(baseMdatOffset);
          for (let i = 0; i < samples.length; i++) {
            co64View.setBigUint64(4 + i * 8, curr);
            curr += BigInt(samples[i].data.length);
          }
        }
        stcoV = TSToMP4Converter.fullBox('co64', 0, 0, co64Payload);
      }

      const stblParts = [stsdV, sttsV, stssV];
      if (hasCtts) stblParts.push(cttsV);
      stblParts.push(stscV, stszV, stcoV);
      const stblV = TSToMP4Converter.box('stbl', TSToMP4Converter.concat(stblParts));

      const vmhd = TSToMP4Converter.fullBox('vmhd', 0, 1, new Uint8Array(8));
      const minfV = TSToMP4Converter.box('minf', TSToMP4Converter.concat([vmhd, dinf, stblV]));
      const hdlrV = TSToMP4Converter.fullBox('hdlr', 0, 0,
        TSToMP4Converter.concat([
          new Uint8Array(4),
          new Uint8Array([0x76, 0x69, 0x64, 0x65]), // 'vide'
          new Uint8Array(12),
          new Uint8Array([0x56, 0x69, 0x64, 0x65, 0x6F, 0x48, 0x61, 0x6E, 0x64, 0x6C, 0x65, 0x72, 0])
        ])
      );
      const mdhdPayload = new Uint8Array(16);
      const mdhdView = new DataView(mdhdPayload.buffer);
      mdhdView.setUint32(8, timescale);
      mdhdView.setUint32(12, totalVDur);
      const mdhdV = TSToMP4Converter.fullBox('mdhd', 0, 0, mdhdPayload);

      const mdiaV = TSToMP4Converter.box('mdia', TSToMP4Converter.concat([mdhdV, hdlrV, minfV]));

      const tkhdPayload = new Uint8Array(84);
      const tkhdView = new DataView(tkhdPayload.buffer);
      tkhdView.setUint32(8, 1);
      tkhdView.setUint32(16, scaledVDur);
      tkhdPayload.set(matrix, 40);
      tkhdView.setUint32(76, width << 16);
      tkhdView.setUint32(80, height << 16);
      const tkhdV = TSToMP4Converter.fullBox('tkhd', 0, 3, tkhdPayload);

      trakV = TSToMP4Converter.box('trak', TSToMP4Converter.concat([tkhdV, mdiaV]));
    }

    // 2. Audio trak
    let trakA = null;
    if (audioData) {
      const { samples, sampleRate, channels, profile } = audioData;

      // AudioSpecificConfig (2 bytes)
      const freqIdx = Math.max(0, rateIndices.indexOf(sampleRate));
      const asc = new Uint8Array([
        ((profile & 0x1F) << 3) | ((freqIdx >> 1) & 7),
        ((freqIdx & 1) << 7) | ((channels & 0x0F) << 3)
      ]);

      // esds
      const decSpec = new Uint8Array(2 + asc.length);
      decSpec[0] = 0x05; decSpec[1] = asc.length;
      decSpec.set(asc, 2);

      const decCfg = new Uint8Array(15 + decSpec.length);
      decCfg[0] = 0x04; decCfg[1] = 13 + decSpec.length;
      decCfg[2] = 0x40; decCfg[3] = 0x15;
      decCfg.set(decSpec, 15);

      const slCfg = new Uint8Array([0x06, 1, 0x02]);

      const esDescr = new Uint8Array(5 + decCfg.length + slCfg.length);
      esDescr[0] = 0x03; esDescr[1] = 3 + decCfg.length + slCfg.length;
      esDescr[2] = 0; esDescr[3] = 2; esDescr[4] = 0;
      esDescr.set(decCfg, 5);
      esDescr.set(slCfg, 5 + decCfg.length);

      const esds = TSToMP4Converter.fullBox('esds', 0, 0, esDescr);

      // mp4a sample entry (28 bytes before esds)
      const mp4aPayload = new Uint8Array(28 + esds.length);
      const mp4aView = new DataView(mp4aPayload.buffer);
      mp4aView.setUint16(6, 1);
      mp4aView.setUint16(16, channels);
      mp4aView.setUint16(18, 16);
      mp4aView.setUint32(24, sampleRate << 16);
      mp4aPayload.set(esds, 28);
      const mp4aBox = TSToMP4Converter.box('mp4a', mp4aPayload);

      const stsdA = TSToMP4Converter.fullBox('stsd', 0, 0,
        TSToMP4Converter.concat([new Uint8Array([0, 0, 0, 1]), mp4aBox])
      );

      const sttsPayload = new Uint8Array(12);
      const sttsView = new DataView(sttsPayload.buffer);
      sttsView.setUint32(0, 1);
      sttsView.setUint32(4, samples.length);
      sttsView.setUint32(8, 1024);
      const sttsA = TSToMP4Converter.fullBox('stts', 0, 0, sttsPayload);

      const stscPayload = new Uint8Array(16);
      const stscView = new DataView(stscPayload.buffer);
      stscView.setUint32(0, 1);
      stscView.setUint32(4, 1);
      stscView.setUint32(8, 1);
      stscView.setUint32(12, 1);
      const stscA = TSToMP4Converter.fullBox('stsc', 0, 0, stscPayload);

      const stszPayload = new Uint8Array(8 + samples.length * 4);
      const stszView = new DataView(stszPayload.buffer);
      stszView.setUint32(0, 0);
      stszView.setUint32(4, samples.length);
      for (let i = 0; i < samples.length; i++) {
        stszView.setUint32(8 + i * 4, samples[i].data.length);
      }
      const stszA = TSToMP4Converter.fullBox('stsz', 0, 0, stszPayload);

      // stco / co64: populated directly with baseMdatOffset + vMdatTotal
      let stcoA;
      if (!is64Bit) {
        const stcoPayload = new Uint8Array(4 + samples.length * 4);
        const stcoView = new DataView(stcoPayload.buffer);
        stcoView.setUint32(0, samples.length);
        if (baseMdatOffset > 0) {
          let curr = baseMdatOffset + vMdatTotal;
          for (let i = 0; i < samples.length; i++) {
            stcoView.setUint32(4 + i * 4, curr);
            curr += samples[i].data.length;
          }
        }
        stcoA = TSToMP4Converter.fullBox('stco', 0, 0, stcoPayload);
      } else {
        const co64Payload = new Uint8Array(4 + samples.length * 8);
        const co64View = new DataView(co64Payload.buffer);
        co64View.setUint32(0, samples.length);
        if (baseMdatOffset > 0) {
          let curr = BigInt(baseMdatOffset + vMdatTotal);
          for (let i = 0; i < samples.length; i++) {
            co64View.setBigUint64(4 + i * 8, curr);
            curr += BigInt(samples[i].data.length);
          }
        }
        stcoA = TSToMP4Converter.fullBox('co64', 0, 0, co64Payload);
      }

      const stblA = TSToMP4Converter.box('stbl', TSToMP4Converter.concat([stsdA, sttsA, stscA, stszA, stcoA]));
      const smhd = TSToMP4Converter.fullBox('smhd', 0, 0, new Uint8Array(4));
      const minfA = TSToMP4Converter.box('minf', TSToMP4Converter.concat([smhd, dinf, stblA]));
      const hdlrA = TSToMP4Converter.fullBox('hdlr', 0, 0,
        TSToMP4Converter.concat([
          new Uint8Array(4),
          new Uint8Array([0x73, 0x6F, 0x75, 0x6E]), // 'soun'
          new Uint8Array(12),
          new Uint8Array([0x53, 0x6F, 0x75, 0x6E, 0x64, 0x68, 0x61, 0x6E, 0x64, 0x6C, 0x65, 0x72, 0])
        ])
      );
      const mdhdPayload = new Uint8Array(16);
      const mdhdView = new DataView(mdhdPayload.buffer);
      mdhdView.setUint32(8, sampleRate);
      mdhdView.setUint32(12, totalADur);
      const mdhdA = TSToMP4Converter.fullBox('mdhd', 0, 0, mdhdPayload);

      const mdiaA = TSToMP4Converter.box('mdia', TSToMP4Converter.concat([mdhdA, hdlrA, minfA]));

      const tkhdPayload = new Uint8Array(84);
      const tkhdView = new DataView(tkhdPayload.buffer);
      tkhdView.setUint32(8, 2);
      tkhdView.setUint32(16, scaledADur);
      tkhdView.setUint16(32, 0x0100);
      tkhdPayload.set(matrix, 40);
      const tkhdA = TSToMP4Converter.fullBox('tkhd', 0, 3, tkhdPayload);

      trakA = TSToMP4Converter.box('trak', TSToMP4Converter.concat([tkhdA, mdiaA]));
    }

    // 3. mvhd
    const mvhdPayload = new Uint8Array(96);
    const mvhdView = new DataView(mvhdPayload.buffer);
    mvhdView.setUint32(8, mvhdTimescale);
    mvhdView.setUint32(12, maxDur);
    mvhdView.setUint32(16, 0x00010000);
    mvhdView.setUint16(20, 0x0100);
    mvhdPayload.set(matrix, 32);
    mvhdView.setUint32(92, 3);
    const mvhd = TSToMP4Converter.fullBox('mvhd', 0, 0, mvhdPayload);

    // Assemble moov
    const moovParts = [mvhd];
    if (trakV) moovParts.push(trakV);
    if (trakA) moovParts.push(trakA);
    return TSToMP4Converter.box('moov', TSToMP4Converter.concat(moovParts));
  }

  /**
   * Builds an ftyp box
   */
  static buildFtyp() {
    const ftypPayload = new Uint8Array(16);
    ftypPayload[0] = 0x69; ftypPayload[1] = 0x73; ftypPayload[2] = 0x6F; ftypPayload[3] = 0x6D; // isom
    new DataView(ftypPayload.buffer).setUint32(4, 512);
    ftypPayload[8] = 0x69; ftypPayload[9] = 0x73; ftypPayload[10] = 0x6F; ftypPayload[11] = 0x6D;
    ftypPayload[12] = 0x69; ftypPayload[13] = 0x73; ftypPayload[14] = 0x6F; ftypPayload[15] = 0x32;
    return TSToMP4Converter.box('ftyp', ftypPayload);
  }

  /**
   * Assemble complete ISO BMFF MP4 Blob from parsed video and audio data
   * Uses zero duplicate copies for mdat sample data.
   */
  static buildMP4Blob(videoData, audioData) {
    const ftyp = TSToMP4Converter.buildFtyp();

    const vSamples = videoData ? videoData.samples : [];
    const aSamples = audioData ? audioData.samples : [];
    let mdatTotal = 0;
    for (let i = 0; i < vSamples.length; i++) mdatTotal += vSamples[i].data.length;
    for (let i = 0; i < aSamples.length; i++) mdatTotal += aSamples[i].data.length;

    // Determine mdat header size
    const is64Bit = (mdatTotal + 8) > 0xFFFFFFFF;
    const mdatHeaderLen = is64Bit ? 16 : 8;

    // Pass 1: compute exact moov length with placeholder offsets
    const dryMoov = TSToMP4Converter.buildMoov(videoData, audioData, 0, is64Bit);
    const baseMdatOffset = ftyp.length + dryMoov.length + mdatHeaderLen;

    // Pass 2: generate final moov with real chunk offsets populated directly in stco/co64
    const moov = TSToMP4Converter.buildMoov(videoData, audioData, baseMdatOffset, is64Bit);

    // Build mdat header
    const mdatHeader = new Uint8Array(mdatHeaderLen);
    const mView = new DataView(mdatHeader.buffer);
    if (!is64Bit) {
      mView.setUint32(0, 8 + mdatTotal);
      mdatHeader.set([0x6D, 0x64, 0x61, 0x74], 4); // 'mdat'
    } else {
      mView.setUint32(0, 1);
      mdatHeader.set([0x6D, 0x64, 0x61, 0x74], 4);
      mView.setBigUint64(8, BigInt(16 + mdatTotal));
    }

    // Assemble Blob parts: references to existing typed arrays with zero extra copying
    const blobParts = [ftyp, moov, mdatHeader];
    for (let i = 0; i < vSamples.length; i++) {
      blobParts.push(vSamples[i].data);
    }
    for (let i = 0; i < aSamples.length; i++) {
      blobParts.push(aSamples[i].data);
    }

    return new Blob(blobParts, { type: 'video/mp4' });
  }

  /**
   * Assemble complete ISO BMFF MP4 ArrayBuffer (convenience method)
   */
  static buildMP4(videoData, audioData) {
    const ftyp = TSToMP4Converter.buildFtyp();
    const vSamples = videoData ? videoData.samples : [];
    const aSamples = audioData ? audioData.samples : [];
    let mdatTotal = 0;
    for (let i = 0; i < vSamples.length; i++) mdatTotal += vSamples[i].data.length;
    for (let i = 0; i < aSamples.length; i++) mdatTotal += aSamples[i].data.length;

    const is64Bit = (mdatTotal + 8) > 0xFFFFFFFF;
    const mdatHeaderLen = is64Bit ? 16 : 8;

    const dryMoov = TSToMP4Converter.buildMoov(videoData, audioData, 0, is64Bit);
    const baseMdatOffset = ftyp.length + dryMoov.length + mdatHeaderLen;
    const moov = TSToMP4Converter.buildMoov(videoData, audioData, baseMdatOffset, is64Bit);

    const mdatHeader = new Uint8Array(mdatHeaderLen);
    const mView = new DataView(mdatHeader.buffer);
    if (!is64Bit) {
      mView.setUint32(0, 8 + mdatTotal);
      mdatHeader.set([0x6D, 0x64, 0x61, 0x74], 4);
    } else {
      mView.setUint32(0, 1);
      mdatHeader.set([0x6D, 0x64, 0x61, 0x74], 4);
      mView.setBigUint64(8, BigInt(16 + mdatTotal));
    }

    const totalLen = ftyp.length + moov.length + mdatHeaderLen + mdatTotal;
    const out = new Uint8Array(totalLen);
    out.set(ftyp, 0);
    out.set(moov, ftyp.length);
    out.set(mdatHeader, ftyp.length + moov.length);

    let offset = ftyp.length + moov.length + mdatHeaderLen;
    for (let i = 0; i < vSamples.length; i++) {
      out.set(vSamples[i].data, offset);
      offset += vSamples[i].data.length;
    }
    for (let i = 0; i < aSamples.length; i++) {
      out.set(aSamples[i].data, offset);
      offset += aSamples[i].data.length;
    }
    return out.buffer;
  }

  /**
   * Convert TS segments directly to an ArrayBuffer containing a standard MP4 file
   * @param {ArrayBuffer[]|Uint8Array[]|ArrayBuffer|Uint8Array} segments 
   * @param {Function} onProgress 
   * @returns {ArrayBuffer} Standard MP4 ArrayBuffer
   */
  static convertToArrayBuffer(segments, onProgress = () => {}) {
    onProgress(0.05);

    let segArrays = [];
    if (Array.isArray(segments)) {
      segArrays = segments.map(s => s instanceof Uint8Array ? s : new Uint8Array(s));
    } else if (segments instanceof Uint8Array) {
      segArrays = [segments];
    } else if (segments instanceof ArrayBuffer) {
      segArrays = [new Uint8Array(segments)];
    }

    if (segArrays.length === 0 || segArrays[0].length === 0) {
      throw new Error('No TS data provided for conversion');
    }

    onProgress(0.15);
    const { videoPes, audioPes, sps, pps } = TSToMP4Converter.demuxTS(segArrays);

    if (videoPes.length === 0 && audioPes.length === 0) {
      throw new Error('No video or audio streams found in TS data');
    }

    onProgress(0.40);
    const videoData = videoPes.length > 0 
      ? TSToMP4Converter.parseVideoPes(videoPes, sps, pps)
      : null;
    videoPes.length = 0;

    onProgress(0.60);
    const audioData = audioPes.length > 0 
      ? TSToMP4Converter.parseAudioPes(audioPes)
      : null;
    audioPes.length = 0;

    onProgress(0.85);
    const mp4Buffer = TSToMP4Converter.buildMP4(videoData, audioData);
    onProgress(1.0);
    return mp4Buffer;
  }
}

if (typeof window !== 'undefined') {
  window.TSToMP4Converter = TSToMP4Converter;
}
if (typeof self !== 'undefined') {
  self.TSToMP4Converter = TSToMP4Converter;
}
if (typeof globalThis !== 'undefined') {
  globalThis.TSToMP4Converter = TSToMP4Converter;
}

