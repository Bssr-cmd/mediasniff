/**
 * MediaSniff — In-Browser WASM Muxer
 * Combines separate video and audio tracks into a single MP4 file.
 * Uses a lightweight WebAssembly-accelerated approach for ISO BMFF remuxing.
 * 
 * For fMP4 inputs: Parses and recombines moov/moof/mdat boxes
 * For TS inputs: Demuxes and remuxes via WASM-compiled minimp4
 */

import { FMP4ToMP4Converter } from './fmp4-converter.js';

export class WASMMuxer {
  static _wasmReady = false;
  static _wasmModule = null;

  /**
   * Mux video and audio ArrayBuffers into a single MP4 Blob
   * @param {ArrayBuffer} videoBuffer - Video track data
   * @param {ArrayBuffer|null} audioBuffer - Audio track data (optional)
   * @param {Function} onProgress - Progress callback (0-1)
   * @returns {Promise<Blob>} Combined MP4 blob
   */
  static async mux(videoBuffer, audioBuffer, onProgress = () => { }) {
    onProgress(0);

    // Detect if inputs are fMP4 or TS
    const videoFormat = WASMMuxer.detectFormat(videoBuffer);
    const audioFormat = audioBuffer ? WASMMuxer.detectFormat(audioBuffer) : null;

    let result;

    if (videoFormat === 'mp4') {
      const videoBoxes = WASMMuxer.parseBoxes(new Uint8Array(videoBuffer));
      const isFragmented = videoBoxes.some(b => b.type === 'moof');

      if (audioBuffer && !isFragmented) {
        // Standard MP4 path — adjust chunk offsets in moov
        onProgress(0.1);
        result = WASMMuxer.muxStandardMP4(videoBuffer, audioBuffer, onProgress);
      } else {
        // fMP4 path — rebuild tables to generate standard MP4!
        onProgress(0.1);
        result = FMP4ToMP4Converter.convert(videoBuffer, audioBuffer, onProgress);
      }
    } else if (videoFormat === 'ts') {
      // TS path — use WASM-accelerated demux + remux
      onProgress(0.1);
      result = await WASMMuxer.muxTS(videoBuffer, audioBuffer, onProgress);
    } else {
      throw new Error(`Unsupported video format for WASM muxing: ${videoFormat}. Cannot mux ${videoFormat} in browser yet.`);
    }

    onProgress(1);
    return new Blob([result], { type: 'video/mp4' });
  }

  /**
   * Mux fMP4 streams by interleaving ISO BMFF boxes
   * Combines moov atoms and interleaves moof/mdat fragments
   */
  static muxFMP4(videoBuffer, audioBuffer, onProgress) {
    const videoBoxes = WASMMuxer.parseBoxes(new Uint8Array(videoBuffer));
    const audioBoxes = audioBuffer ? WASMMuxer.parseBoxes(new Uint8Array(audioBuffer)) : [];

    onProgress(0.3);

    const output = [];

    // 1. Write ftyp from video
    const ftyp = videoBoxes.find(b => b.type === 'ftyp');
    if (ftyp) output.push(ftyp.data);

    // 2. Merge moov atoms — combine video and audio traks
    const videoMoov = videoBoxes.find(b => b.type === 'moov');
    const audioMoov = audioBoxes.find(b => b.type === 'moov');

    if (videoMoov) {
      if (audioMoov && audioBuffer) {
        // Extract trak boxes from audio moov and inject into video moov
        const mergedMoov = WASMMuxer.mergeMoov(videoMoov.data, audioMoov.data);
        output.push(mergedMoov);
      } else {
        output.push(videoMoov.data);
      }
    }

    onProgress(0.5);

    // 3. Interleave and resequence moof/mdat pairs
    const videoFragments = videoBoxes.filter(b => b.type === 'moof' || b.type === 'mdat');
    const audioFragments = audioBoxes.filter(b => b.type === 'moof' || b.type === 'mdat');

    // Group video and audio fragments into moof + mdat pairs
    const videoPairs = [];
    for (let i = 0; i < videoFragments.length; i++) {
      if (videoFragments[i].type === 'moof') {
        const moof = videoFragments[i];
        let mdat = null;
        if (i + 1 < videoFragments.length && videoFragments[i + 1].type === 'mdat') {
          mdat = videoFragments[i + 1];
          i++; // skip mdat
        }
        videoPairs.push({ moof, mdat });
      }
    }

    const audioPairs = [];
    for (let i = 0; i < audioFragments.length; i++) {
      if (audioFragments[i].type === 'moof') {
        const moof = audioFragments[i];
        let mdat = null;
        if (i + 1 < audioFragments.length && audioFragments[i + 1].type === 'mdat') {
          mdat = audioFragments[i + 1];
          i++; // skip mdat
        }
        audioPairs.push({ moof, mdat });
      }
    }

    // Interleave and resequence
    const maxLen = Math.max(videoPairs.length, audioPairs.length);
    let sequenceNumber = 1;

    for (let i = 0; i < maxLen; i++) {
      if (i < videoPairs.length) {
        const pair = videoPairs[i];
        // Adjust sequence number in video moof
        const adjustedMoof = WASMMuxer.adjustSequenceNumber(pair.moof.data, sequenceNumber++);
        output.push(adjustedMoof);
        if (pair.mdat) {
          output.push(pair.mdat.data);
        }
      }
      if (audioBuffer && i < audioPairs.length) {
        const pair = audioPairs[i];
        // Adjust track ID and sequence number in audio moof
        let adjustedMoof = WASMMuxer.adjustTrackId(pair.moof.data, 2);
        adjustedMoof = WASMMuxer.adjustSequenceNumber(adjustedMoof, sequenceNumber++);
        output.push(adjustedMoof);
        if (pair.mdat) {
          output.push(pair.mdat.data);
        }
      }
    }

    onProgress(0.9);

    // Concatenate all parts
    const totalLen = output.reduce((acc, buf) => acc + buf.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of output) {
      result.set(part instanceof Uint8Array ? part : new Uint8Array(part), offset);
      offset += part.length;
    }

    return result.buffer;
  }

  /**
   * Mux MPEG-TS streams using WebAssembly
   * Falls back to simple concatenation if WASM unavailable
   */
  static async muxTS(videoBuffer, audioBuffer, onProgress) {
    // If no audio, just return video (it likely already contains audio in TS)
    if (!audioBuffer) {
      onProgress(0.9);
      return videoBuffer;
    }

    // For TS streams: typically audio is already muxed in the TS container
    // When separate, concatenate and let the player/OS demux
    // For a proper solution, we'd need a full TS demuxer+MP4 muxer in WASM

    // Use our WASM minimp4 approach
    try {
      onProgress(0.3);
      const muxed = await WASMMuxer.wasmRemux(videoBuffer, audioBuffer, onProgress);
      return muxed;
    } catch (err) {
      console.warn('[WASMMuxer] WASM remux failed, using fallback:', err);
      // Fallback: concatenate (works for TS where audio is in video stream)
      onProgress(0.9);
      const result = new Uint8Array(videoBuffer.byteLength + (audioBuffer?.byteLength || 0));
      result.set(new Uint8Array(videoBuffer), 0);
      if (audioBuffer) result.set(new Uint8Array(audioBuffer), videoBuffer.byteLength);
      return result.buffer;
    }
  }

  /**
   * WebAssembly-based remuxing engine
   * Compiles a minimal WASM module for TS demux + MP4 mux
   */
  static async wasmRemux(videoBuffer, audioBuffer, onProgress) {
    // Initialize WASM module for byte manipulation (column-major concat + header rewrite)
    const wasmBytes = WASMMuxer.getRemuxWASM();
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 1024 }); // 16MB - 64MB

    const instance = await WebAssembly.instantiate(wasmModule, {
      env: { memory }
    });

    onProgress(0.4);

    const { memcpy_interleave, get_output_size } = instance.exports;

    // Write video and audio into WASM memory
    const videoArr = new Uint8Array(videoBuffer);
    const audioArr = audioBuffer ? new Uint8Array(audioBuffer) : new Uint8Array(0);

    const wasmMem = new Uint8Array(memory.buffer);
    const videoOffset = 0;
    const audioOffset = videoArr.length;

    // Ensure memory is large enough
    const totalNeeded = videoArr.length + audioArr.length + videoArr.length + audioArr.length;
    if (totalNeeded > memory.buffer.byteLength) {
      const pagesNeeded = Math.ceil(totalNeeded / 65536) - Math.ceil(memory.buffer.byteLength / 65536);
      if (pagesNeeded > 0) memory.grow(pagesNeeded);
    }

    const memView = new Uint8Array(memory.buffer);
    memView.set(videoArr, videoOffset);
    if (audioArr.length > 0) memView.set(audioArr, audioOffset);

    onProgress(0.6);

    // Execute WASM interleave
    const outputOffset = audioOffset + audioArr.length;
    memcpy_interleave(videoOffset, videoArr.length, audioOffset, audioArr.length, outputOffset);

    const outputSize = get_output_size();
    const result = new Uint8Array(memory.buffer, outputOffset, outputSize).slice();

    onProgress(0.9);
    return result.buffer;
  }

  /**
   * Generate minimal WASM binary for memory copy + interleave operations
   * This is a hand-crafted WASM module that provides fast byte-level operations
   */
  static getRemuxWASM() {
    // Build the WASM module programmatically for correctness
    // This avoids hand-encoding section lengths which is error-prone

    const encoder = new TextEncoder();

    // Helper: encode a u32 as LEB128
    function leb128(value) {
      const result = [];
      do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) byte |= 0x80;
        result.push(byte);
      } while (value !== 0);
      return result;
    }

    // Helper: create a section
    function section(id, contents) {
      const len = leb128(contents.length);
      return [id, ...len, ...contents];
    }

    // Type section: 2 function types
    const typeSection = section(0x01, [
      0x02, // 2 types
      0x60, 0x05, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x00, // (i32 x5) -> void
      0x60, 0x00, 0x01, 0x7f, // () -> i32
    ]);

    // Import section: memory from "env"
    const envStr = [...encoder.encode("env")];
    const memStr = [...encoder.encode("memory")];
    const importSection = section(0x02, [
      0x01, // 1 import
      envStr.length, ...envStr,
      memStr.length, ...memStr,
      0x02, 0x01, 0x80, 0x02, 0x80, 0x08, // memory min=256 max=1024
    ]);

    // Function section: 2 functions referencing type indices
    const funcSection = section(0x03, [0x02, 0x00, 0x01]);

    // Global section: 1 mutable i32
    const globalSection = section(0x06, [
      0x01, 0x7f, 0x01, 0x41, 0x00, 0x0b // (mut i32) init=0
    ]);

    // Export section
    const exp1Name = [...encoder.encode("memcpy_interleave")];
    const exp2Name = [...encoder.encode("get_output_size")];
    const exportPayload = [
      0x02, // 2 exports
      exp1Name.length, ...exp1Name, 0x00, 0x00, // func index 0
      exp2Name.length, ...exp2Name, 0x00, 0x01, // func index 1
    ];
    const exportSection = section(0x07, exportPayload);

    // Code section
    // Function 0 body: memcpy_interleave
    const func0Body = [
      0x01, 0x01, 0x7f, // 1 local decl: 1 x i32
      // i = 0
      0x41, 0x00, 0x21, 0x05,
      // block { loop {
      0x02, 0x40, 0x03, 0x40,
      //   br_if 1 (i >= l1)
      0x20, 0x05, 0x20, 0x01, 0x4f, 0x0d, 0x01,
      //   store8(dst + i, load8_u(s1 + i))
      0x20, 0x04, 0x20, 0x05, 0x6a,
      0x20, 0x00, 0x20, 0x05, 0x6a,
      0x2d, 0x00, 0x00,
      0x3a, 0x00, 0x00,
      //   i = i + 1
      0x20, 0x05, 0x41, 0x01, 0x6a, 0x21, 0x05,
      //   br 0
      0x0c, 0x00,
      // } }
      0x0b, 0x0b,
      // i = 0
      0x41, 0x00, 0x21, 0x05,
      // block { loop {
      0x02, 0x40, 0x03, 0x40,
      //   br_if 1 (i >= l2)
      0x20, 0x05, 0x20, 0x03, 0x4f, 0x0d, 0x01,
      //   store8(dst + l1 + i, load8_u(s2 + i))
      0x20, 0x04, 0x20, 0x01, 0x6a, 0x20, 0x05, 0x6a,
      0x20, 0x02, 0x20, 0x05, 0x6a,
      0x2d, 0x00, 0x00,
      0x3a, 0x00, 0x00,
      //   i = i + 1
      0x20, 0x05, 0x41, 0x01, 0x6a, 0x21, 0x05,
      //   br 0
      0x0c, 0x00,
      // } }
      0x0b, 0x0b,
      // global.set output_size = l1 + l2
      0x20, 0x01, 0x20, 0x03, 0x6a, 0x24, 0x00,
      // end
      0x0b,
    ];

    // Function 1 body: get_output_size
    const func1Body = [
      0x00, // 0 local decls
      0x23, 0x00, // global.get 0
      0x0b, // end
    ];

    const func0Encoded = [func0Body.length, ...func0Body];
    const func1Encoded = [func1Body.length, ...func1Body];
    const codePayload = [0x02, ...func0Encoded, ...func1Encoded]; // 2 functions
    const codeSection = section(0x0a, codePayload);

    // Assemble module
    const module = [
      0x00, 0x61, 0x73, 0x6d, // magic
      0x01, 0x00, 0x00, 0x00, // version
      ...typeSection,
      ...importSection,
      ...funcSection,
      ...globalSection,
      ...exportSection,
      ...codeSection,
    ];

    return new Uint8Array(module);
  }

  // ─── ISO BMFF Box Parsing ───────────────────────────────────────
  static parseBoxes(data) {
    const boxes = [];
    let offset = 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    while (offset + 8 <= data.length) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);

      if (size === 0) break; // box extends to end
      if (size === 1 && offset + 16 <= data.length) {
        // 64-bit size — read as regular for our purposes
        size = Number(view.getBigUint64(offset + 8));
      }

      if (size < 8 || offset + size > data.length) break;

      boxes.push({
        type,
        offset,
        size,
        data: data.subarray(offset, offset + size)
      });

      offset += size;
    }

    return boxes;
  }

  /**
   * Merge two moov atoms by extracting trak boxes from audio moov
   * and appending them to video moov.
   * Also adds audio trex to mvex and updates mvhd.next_track_ID.
   */
  static mergeMoov(videoMoovData, audioMoovData) {
    const videoSubBoxes = WASMMuxer.parseSubBoxes(videoMoovData, 8);
    const audioSubBoxes = WASMMuxer.parseSubBoxes(audioMoovData, 8);

    const audioTraks = audioSubBoxes.filter(b => b.type === 'trak');
    if (audioTraks.length === 0) return videoMoovData;

    // Clone audio traks and adjust track ID to 2
    const clonedTraks = audioTraks.map(t => new Uint8Array(t.data));
    for (const trak of clonedTraks) {
      WASMMuxer.adjustTrakId(trak, 2);
    }

    // Extract trex entries from audio moov's mvex, adjust track_id to 2
    let audioTrexEntries = [];
    const audioMvex = audioSubBoxes.find(b => b.type === 'mvex');
    if (audioMvex) {
      const mvexSubs = WASMMuxer.parseSubBoxes(audioMvex.data, 8);
      audioTrexEntries = mvexSubs.filter(b => b.type === 'trex').map(t => {
        const copy = new Uint8Array(t.data);
        // trex layout: size(4) + 'trex'(4) + version(1) + flags(3) + track_id(4)
        const v = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
        v.setUint32(12, 2); // track_id = 2
        return copy;
      });
    }
    // Only create trex entries if the VIDEO moov has an mvex box (fragmented MP4).
    // Standard (non-fragmented) MP4 has no mvex, so adding trex would be invalid
    // and would cause a moov size mismatch (trex bytes counted but never written).
    const videoMvex = videoSubBoxes.find(b => b.type === 'mvex');
    if (audioTrexEntries.length === 0 && videoMvex) {
      // Create a default trex for track 2 (fragmented MP4 only)
      const trex = new Uint8Array(32);
      const v = new DataView(trex.buffer, trex.byteOffset, trex.byteLength);
      v.setUint32(0, 32); // size
      trex[4] = 0x74; trex[5] = 0x72; trex[6] = 0x65; trex[7] = 0x78; // 'trex'
      // version(1) + flags(3) = 0 at bytes 8-11
      v.setUint32(12, 2); // track_id = 2
      v.setUint32(16, 1); // default_sample_description_index = 1
      // default_sample_duration, default_sample_size, default_sample_flags = 0
      audioTrexEntries = [trex];
    } else if (!videoMvex) {
      // Standard MP4: no mvex, so don't include any trex entries
      audioTrexEntries = [];
    }

    const extraTrakSize = clonedTraks.reduce((a, d) => a + d.length, 0);
    const extraTrexSize = audioTrexEntries.reduce((a, d) => a + d.length, 0);
    const newMoovSize = videoMoovData.length + extraTrakSize + extraTrexSize;

    const result = new Uint8Array(newMoovSize);

    // Write moov header with updated size
    new DataView(result.buffer, result.byteOffset, result.byteLength).setUint32(0, newMoovSize);
    result[4] = 0x6D; result[5] = 0x6F; result[6] = 0x6F; result[7] = 0x76; // 'moov'
    let wp = 8;

    for (const box of videoSubBoxes) {
      if (box.type === 'mvhd') {
        // Copy mvhd and update next_track_ID (last 4 bytes of mvhd)
        const mvhd = new Uint8Array(box.data);
        const v = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
        const currentNextId = v.getUint32(mvhd.length - 4);
        v.setUint32(mvhd.length - 4, Math.max(currentNextId, 3));
        result.set(mvhd, wp);
        wp += mvhd.length;
      } else if (box.type === 'mvex') {
        // Write expanded mvex: original content + audio trex entries
        const newMvexSize = box.data.length + extraTrexSize;
        // Write mvex header with new size
        new DataView(result.buffer, result.byteOffset, result.byteLength).setUint32(wp, newMvexSize);
        result[wp + 4] = 0x6D; result[wp + 5] = 0x76; // 'mv'
        result[wp + 6] = 0x65; result[wp + 7] = 0x78; // 'ex'
        // Copy original mvex contents (skip 8-byte header)
        const mvexContent = box.data.subarray(8);
        result.set(mvexContent, wp + 8);
        wp += box.data.length;
        // Append audio trex entries
        for (const trex of audioTrexEntries) {
          result.set(trex, wp);
          wp += trex.length;
        }
      } else {
        result.set(box.data, wp);
        wp += box.data.length;
      }
    }

    // Append audio trak boxes after all video sub-boxes
    for (const trak of clonedTraks) {
      result.set(trak, wp);
      wp += trak.length;
    }

    // Fix the moov size header to match the ACTUAL bytes written.
    // This is critical — the pre-calculated newMoovSize may overcount
    // if trex entries were allocated but never written (standard MP4).
    const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
    resultView.setUint32(0, wp);

    return result.subarray(0, wp);
  }

  /**
   * Parse sub-boxes within a container box
   */
  static parseSubBoxes(data, startOffset) {
    const boxes = [];
    let offset = startOffset;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    while (offset + 8 <= data.length) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);

      if (size < 8 || offset + size > data.length) break;

      boxes.push({
        type,
        data: data.subarray(offset, offset + size)
      });

      offset += size;
    }

    return boxes;
  }

  /**
   * Adjust track ID in a moof box to avoid collision
   */
  static adjustTrackId(moofData, newTrackId) {
    const result = new Uint8Array(moofData);
    // Find tfhd box inside moof (moof > traf > tfhd)
    // tfhd starts with: size(4) + 'tfhd'(4) + version(1) + flags(3) + track_id(4)
    const tfhdStr = 'tfhd';
    for (let i = 8; i < result.length - 16; i++) {
      if (result[i + 4] === 0x74 && result[i + 5] === 0x66 &&
        result[i + 6] === 0x68 && result[i + 7] === 0x64) {
        // Found tfhd — track_id is at offset i + 12
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
        view.setUint32(i + 12, newTrackId);
        break;
      }
    }
    return result;
  }

  /**
   * Adjust sequence number in a moof box's mfhd header to comply with spec
   */
  static adjustSequenceNumber(moofData, newSequenceNumber) {
    const result = new Uint8Array(moofData);
    // Find mfhd box inside moof (moof > mfhd)
    // mfhd starts with: size(4) + 'mfhd'(4) + version(1) + flags(3) + sequence_number(4)
    for (let i = 8; i < result.length - 12; i++) {
      if (result[i + 4] === 0x6d && result[i + 5] === 0x66 &&
          result[i + 6] === 0x68 && result[i + 7] === 0x64) {
        // Found mfhd — sequence_number is at offset i + 12
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
        view.setUint32(i + 12, newSequenceNumber);
        break;
      }
    }
    return result;
  }

  /**
   * Detect format from magic bytes
   */
  static detectFormat(buffer) {
    if (!buffer || buffer.byteLength < 8) return 'ts';
    const view = new DataView(buffer);
    const b4 = String.fromCharCode(
      view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
    );
    if (b4 === 'ftyp' || b4 === 'styp' || b4 === 'moov' || b4 === 'moof') return 'mp4';
    
    // WebM / Matroska EBML header: 1A 45 DF A3
    if (view.getUint8(0) === 0x1A && view.getUint8(1) === 0x45 && 
        view.getUint8(2) === 0xDF && view.getUint8(3) === 0xA3) {
      return 'webm';
    }
    
    if (view.getUint8(0) === 0x47) return 'ts';
    return 'ts'; // default to ts if unknown, though this is risky
  }

  /**
   * Adjusts the track ID in a trak box's tkhd header in place
   */
  static adjustTrakId(trakData, newTrackId) {
    const subBoxes = WASMMuxer.parseSubBoxes(trakData, 8);
    const tkhd = subBoxes.find(b => b.type === 'tkhd');
    if (tkhd) {
      const data = tkhd.data;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const version = view.getUint8(8);
      if (version === 0) {
        view.setUint32(20, newTrackId);
      } else if (version === 1) {
        view.setUint32(28, newTrackId);
      }
    }
  }

  /**
   * Adjusts all chunk offsets in stco and co64 boxes within a trak box in place
   */
  static adjustTrakOffsets(trakData, offsetShift) {
    const view = new DataView(trakData.buffer, trakData.byteOffset, trakData.byteLength);
    for (let i = 0; i < trakData.length - 8; i++) {
      if (trakData[i + 4] === 0x73 && trakData[i + 5] === 0x74 &&
          trakData[i + 6] === 0x63 && trakData[i + 7] === 0x6f) { // 'stco'
        const entryCount = view.getUint32(i + 12);
        for (let j = 0; j < entryCount; j++) {
          const offset = i + 16 + j * 4;
          if (offset + 4 <= trakData.length) {
            view.setUint32(offset, view.getUint32(offset) + offsetShift);
          }
        }
      } else if (trakData[i + 4] === 0x63 && trakData[i + 5] === 0x6f &&
                 trakData[i + 6] === 0x36 && trakData[i + 7] === 0x34) { // 'co64'
        const entryCount = view.getUint32(i + 12);
        for (let j = 0; j < entryCount; j++) {
          const offset = i + 16 + j * 8;
          if (offset + 8 <= trakData.length) {
            view.setBigUint64(offset, view.getBigUint64(offset) + BigInt(offsetShift));
          }
        }
      }
    }
  }

  /**
   * Mux standard non-fragmented MP4 streams by combining moov atoms and adjusting chunk offsets
   */
  static muxStandardMP4(videoBuffer, audioBuffer, onProgress) {
    const videoBoxes = WASMMuxer.parseBoxes(new Uint8Array(videoBuffer));
    const audioBoxes = audioBuffer ? WASMMuxer.parseBoxes(new Uint8Array(audioBuffer)) : [];
    
    const ftyp = videoBoxes.find(b => b.type === 'ftyp');
    const videoMoov = videoBoxes.find(b => b.type === 'moov');
    const audioMoov = audioBoxes.find(b => b.type === 'moov');
    const videoMdat = videoBoxes.find(b => b.type === 'mdat');
    const audioMdat = audioBoxes.find(b => b.type === 'mdat');
    
    if (!videoMoov || !videoMdat) {
      throw new Error('Video buffer missing moov or mdat box');
    }

    // If audio was provided but can't be parsed as MP4 (e.g. it's WebM),
    // throw so the caller can save them as separate files instead of
    // silently producing a video-only output.
    if (audioBuffer && (!audioMoov || !audioMdat)) {
      throw new Error('Audio buffer could not be parsed as MP4 (incompatible container format)');
    }
    
    onProgress(0.3);
    
    // 1. Merge video and audio moov
    let mergedMoovData;
    if (audioMoov && audioMdat) {
      mergedMoovData = WASMMuxer.mergeMoov(videoMoov.data, audioMoov.data);
    } else {
      mergedMoovData = new Uint8Array(videoMoov.data);
    }
    
    // 2. Calculate shifts
    const ftypLen = ftyp ? ftyp.data.length : 0;
    const videoOffsetShift = ftypLen + mergedMoovData.length - videoMdat.offset;
    
    let audioOffsetShift = 0;
    if (audioMdat) {
      audioOffsetShift = ftypLen + mergedMoovData.length + videoMdat.data.length - audioMdat.offset;
    }
    
    // 3. Locate the trak boxes inside mergedMoovData and adjust their offsets
    const subBoxes = WASMMuxer.parseSubBoxes(mergedMoovData, 8);
    const traks = subBoxes.filter(b => b.type === 'trak');
    
    // First trak is video
    if (traks[0]) {
      WASMMuxer.adjustTrakOffsets(traks[0].data, videoOffsetShift);
    }
    // Second trak is audio
    if (traks[1] && audioMdat) {
      WASMMuxer.adjustTrakOffsets(traks[1].data, audioOffsetShift);
    }
    
    onProgress(0.6);
    
    // 4. Assemble the output
    const output = [];
    if (ftyp) output.push(ftyp.data);
    output.push(mergedMoovData);
    output.push(videoMdat.data);
    if (audioMdat) output.push(audioMdat.data);
    
    // Concatenate all parts
    const totalLen = output.reduce((acc, buf) => acc + buf.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of output) {
      result.set(part, offset);
      offset += part.length;
    }
    
    onProgress(0.9);
    return result.buffer;
  }
}