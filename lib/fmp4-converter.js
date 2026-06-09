export class FMP4ToMP4Converter {
  static convert(videoBuffer, audioBuffer, onProgress) {
    onProgress(0.1);
    
    // Parse boxes
    const videoBoxes = FMP4ToMP4Converter.parseBoxes(new Uint8Array(videoBuffer));
    const audioBoxes = audioBuffer ? FMP4ToMP4Converter.parseBoxes(new Uint8Array(audioBuffer)) : [];
    
    // Extract moovs
    const videoMoov = videoBoxes.find(b => b.type === 'moov');
    const audioMoov = audioBoxes.find(b => b.type === 'moov');
    
    if (!videoMoov) throw new Error('Video missing moov box');
    
    // Extract base traks
    const videoTraks = FMP4ToMP4Converter.parseSubBoxes(videoMoov.data, 8).filter(b => b.type === 'trak');
    if (videoTraks.length === 0) throw new Error('Video missing trak');
    
    const audioTraks = audioMoov ? FMP4ToMP4Converter.parseSubBoxes(audioMoov.data, 8).filter(b => b.type === 'trak') : [];
    
    // Extract defaults from mvex/trex
    const videoDefaults = FMP4ToMP4Converter.extractTrexDefaults(videoMoov.data);
    const audioDefaults = audioMoov ? FMP4ToMP4Converter.extractTrexDefaults(audioMoov.data) : null;
    
    onProgress(0.3);
    
    // Parse samples and extract raw mdat data
    const videoTrackData = FMP4ToMP4Converter.extractSamples(videoBoxes, videoDefaults);
    const audioTrackData = audioBuffer ? FMP4ToMP4Converter.extractSamples(audioBoxes, audioDefaults) : null;
    
    onProgress(0.5);
    
    // Build new traks
    const newVideoTrak = FMP4ToMP4Converter.rebuildTrak(videoTraks[0].data, videoTrackData, 1);
    let newAudioTrak = null;
    if (audioTrackData && audioTraks.length > 0) {
      newAudioTrak = FMP4ToMP4Converter.rebuildTrak(audioTraks[0].data, audioTrackData, 2);
    }
    
    // Rebuild moov
    const newMoov = FMP4ToMP4Converter.rebuildMoov(videoMoov.data, newVideoTrak, newAudioTrak);
    
    onProgress(0.7);
    
    // Compute offsets
    // ftyp = 32 bytes
    const ftyp = FMP4ToMP4Converter.createFtyp();
    let mdatHeaderSize = 8;
    const videoDataLen = videoTrackData.data.reduce((acc, a) => acc + a.length, 0);
    const audioDataLen = audioTrackData ? audioTrackData.data.reduce((acc, a) => acc + a.length, 0) : 0;
    
    let totalMdatSize = videoDataLen + audioDataLen;
    let mdatHeader = new Uint8Array(8);
    let view = new DataView(mdatHeader.buffer);
    view.setUint32(0, totalMdatSize + 8);
    mdatHeader[4] = 0x6D; mdatHeader[5] = 0x64; mdatHeader[6] = 0x61; mdatHeader[7] = 0x74; // 'mdat'
    
    // We need to patch stco (chunk offsets)
    // Video chunk offset = ftyp.length + newMoov.length + 8
    const videoChunkOffset = ftyp.length + newMoov.length + 8;
    const audioChunkOffset = videoChunkOffset + videoDataLen;
    
    FMP4ToMP4Converter.patchStco(newMoov, 1, videoChunkOffset);
    if (newAudioTrak) {
      FMP4ToMP4Converter.patchStco(newMoov, 2, audioChunkOffset);
    }
    
    onProgress(0.9);
    
    // Assemble final file
    const totalLen = ftyp.length + newMoov.length + mdatHeader.length + totalMdatSize;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    
    result.set(ftyp, offset); offset += ftyp.length;
    result.set(newMoov, offset); offset += newMoov.length;
    result.set(mdatHeader, offset); offset += mdatHeader.length;
    
    for (const chunk of videoTrackData.data) {
      result.set(chunk, offset); offset += chunk.length;
    }
    if (audioTrackData) {
      for (const chunk of audioTrackData.data) {
        result.set(chunk, offset); offset += chunk.length;
      }
    }
    
    onProgress(1.0);
    return result.buffer;
  }

  static parseBoxes(data) {
    const boxes = [];
    let offset = 0;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    while (offset + 8 <= data.length) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);

      if (size === 0) break; 
      if (size === 1 && offset + 16 <= data.length) {
        size = Number(view.getBigUint64(offset + 8));
      }
      if (size < 8 || offset + size > data.length) break;

      boxes.push({ type, offset, size, data: data.subarray(offset, offset + size) });
      offset += size;
    }
    return boxes;
  }

  static parseSubBoxes(data, startOffset) {
    const boxes = [];
    let offset = startOffset;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    while (offset + 8 <= data.length) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);

      if (size < 8 || offset + size > data.length) break;
      boxes.push({ type, offset, size, data: data.subarray(offset, offset + size) });
      offset += size;
    }
    return boxes;
  }

  static extractTrexDefaults(moovData) {
    const mvex = FMP4ToMP4Converter.parseSubBoxes(moovData, 8).find(b => b.type === 'mvex');
    if (!mvex) return { duration: 0, size: 0, flags: 0 };
    const trex = FMP4ToMP4Converter.parseSubBoxes(mvex.data, 8).find(b => b.type === 'trex');
    if (!trex) return { duration: 0, size: 0, flags: 0 };
    const view = new DataView(trex.data.buffer, trex.data.byteOffset, trex.data.byteLength);
    return {
      duration: view.getUint32(20),
      size: view.getUint32(24),
      flags: view.getUint32(28)
    };
  }

  static extractSamples(boxes, defaults) {
    const result = {
      samples: [],
      data: [],
      totalDuration: 0
    };

    let currentMoof = null;

    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.type === 'moof') {
        currentMoof = box;
      } else if (box.type === 'mdat' && currentMoof) {
        // Parse traf inside moof
        const traf = FMP4ToMP4Converter.parseSubBoxes(currentMoof.data, 8).find(b => b.type === 'traf');
        if (!traf) continue;

        const tfhd = FMP4ToMP4Converter.parseSubBoxes(traf.data, 8).find(b => b.type === 'tfhd');
        const trun = FMP4ToMP4Converter.parseSubBoxes(traf.data, 8).find(b => b.type === 'trun');
        if (!tfhd || !trun) continue;

        const tfhdView = new DataView(tfhd.data.buffer, tfhd.data.byteOffset, tfhd.data.byteLength);
        const tfhdFlags = tfhdView.getUint32(8) & 0xFFFFFF;
        
        let defDur = defaults.duration;
        let defSize = defaults.size;
        
        let tfhdOffset = 16; // size(4), type(4), v+flags(4), trackId(4) = 16
        if (tfhdFlags & 0x000001) tfhdOffset += 8; // base_data_offset
        if (tfhdFlags & 0x000002) tfhdOffset += 4; // sample_description_index
        if (tfhdFlags & 0x000008) { defDur = tfhdView.getUint32(tfhdOffset); tfhdOffset += 4; }
        if (tfhdFlags & 0x000010) { defSize = tfhdView.getUint32(tfhdOffset); tfhdOffset += 4; }

        const trunView = new DataView(trun.data.buffer, trun.data.byteOffset, trun.data.byteLength);
        const trunFlags = trunView.getUint32(8) & 0xFFFFFF;
        const sampleCount = trunView.getUint32(12);

        let dataOffset = 0;
        let trunOffset = 16;
        if (trunFlags & 0x000001) { dataOffset = trunView.getInt32(trunOffset); trunOffset += 4; }
        if (trunFlags & 0x000004) trunOffset += 4; // first_sample_flags

        let mdatOffset = dataOffset > 0 ? dataOffset - 8 : 0; // Relative to mdat payload start (approx)
        let currentMdatOffset = (dataOffset > 0 && currentMoof) ? (dataOffset - currentMoof.size) : 8;
        if (currentMdatOffset < 8 || currentMdatOffset > box.data.length) {
           currentMdatOffset = 8; // fallback if dataOffset was absolute or malformed
        }
        
        // Actually, let's just parse the lengths and slice directly.
        for (let s = 0; s < sampleCount; s++) {
          let dur = defDur;
          let size = defSize;
          let ctts = 0;

          if (trunFlags & 0x000100) { dur = trunView.getUint32(trunOffset); trunOffset += 4; }
          if (trunFlags & 0x000200) { size = trunView.getUint32(trunOffset); trunOffset += 4; }
          if (trunFlags & 0x000400) trunOffset += 4; // flags
          if (trunFlags & 0x000800) { 
            const version = trunView.getUint8(8);
            ctts = version === 1 ? trunView.getInt32(trunOffset) : trunView.getUint32(trunOffset);
            trunOffset += 4; 
          }

          result.samples.push({ duration: dur, size: size, ctts: ctts });
          result.totalDuration += dur;
          
          if (currentMdatOffset + size <= box.data.length) {
            result.data.push(box.data.subarray(currentMdatOffset, currentMdatOffset + size));
          } else {
            console.warn(`Sample size ${size} exceeds mdat bounds`);
          }
          currentMdatOffset += size;
        }
        currentMoof = null;
      }
    }
    return result;
  }

  static writeBox(type, payload) {
    const box = new Uint8Array(8 + payload.length);
    const view = new DataView(box.buffer);
    view.setUint32(0, box.length);
    box[4] = type.charCodeAt(0);
    box[5] = type.charCodeAt(1);
    box[6] = type.charCodeAt(2);
    box[7] = type.charCodeAt(3);
    box.set(payload, 8);
    return box;
  }

  static writeFullBox(type, version, flags, payload) {
    const fullPayload = new Uint8Array(4 + payload.length);
    const view = new DataView(fullPayload.buffer);
    view.setUint32(0, (version << 24) | (flags & 0xFFFFFF));
    fullPayload.set(payload, 4);
    return FMP4ToMP4Converter.writeBox(type, fullPayload);
  }

  static rebuildTrak(trakData, trackInfo, trackId) {
    const mdia = FMP4ToMP4Converter.parseSubBoxes(trakData, 8).find(b => b.type === 'mdia');
    const minf = FMP4ToMP4Converter.parseSubBoxes(mdia.data, 8).find(b => b.type === 'minf');
    const stbl = FMP4ToMP4Converter.parseSubBoxes(minf.data, 8).find(b => b.type === 'stbl');
    const stsd = FMP4ToMP4Converter.parseSubBoxes(stbl.data, 8).find(b => b.type === 'stsd');

    // Build stts
    let sttsEntries = [];
    let currentDur = -1;
    let currentCount = 0;
    for (const s of trackInfo.samples) {
      if (s.duration === currentDur) {
        currentCount++;
      } else {
        if (currentCount > 0) sttsEntries.push({ count: currentCount, dur: currentDur });
        currentDur = s.duration;
        currentCount = 1;
      }
    }
    if (currentCount > 0) sttsEntries.push({ count: currentCount, dur: currentDur });

    const sttsPayload = new Uint8Array(4 + sttsEntries.length * 8);
    const sttsView = new DataView(sttsPayload.buffer);
    sttsView.setUint32(0, sttsEntries.length);
    for (let i = 0; i < sttsEntries.length; i++) {
      sttsView.setUint32(4 + i*8, sttsEntries[i].count);
      sttsView.setUint32(8 + i*8, sttsEntries[i].dur);
    }
    const sttsBox = FMP4ToMP4Converter.writeFullBox('stts', 0, 0, sttsPayload);

    // Build stsz
    const stszPayload = new Uint8Array(8 + trackInfo.samples.length * 4);
    const stszView = new DataView(stszPayload.buffer);
    stszView.setUint32(0, 0); // uniform size = 0
    stszView.setUint32(4, trackInfo.samples.length);
    for (let i = 0; i < trackInfo.samples.length; i++) {
      stszView.setUint32(8 + i*4, trackInfo.samples[i].size);
    }
    const stszBox = FMP4ToMP4Converter.writeFullBox('stsz', 0, 0, stszPayload);

    // Build stsc (1 chunk)
    const stscPayload = new Uint8Array(4 + 12);
    const stscView = new DataView(stscPayload.buffer);
    stscView.setUint32(0, 1); // 1 entry
    stscView.setUint32(4, 1); // first chunk = 1
    stscView.setUint32(8, trackInfo.samples.length); // samples per chunk
    stscView.setUint32(12, 1); // sample description index = 1
    const stscBox = FMP4ToMP4Converter.writeFullBox('stsc', 0, 0, stscPayload);

    // Build stco (placeholder)
    const stcoPayload = new Uint8Array(4 + 4);
    const stcoView = new DataView(stcoPayload.buffer);
    stcoView.setUint32(0, 1); // 1 entry
    stcoView.setUint32(4, 0); // placeholder offset
    const stcoBox = FMP4ToMP4Converter.writeFullBox('stco', 0, 0, stcoPayload);

    // Build ctts (if needed)
    const hasCtts = trackInfo.samples.some(s => s.ctts !== 0);
    let cttsBox = new Uint8Array(0);
    if (hasCtts) {
      let cttsEntries = [];
      let currentOffset = -1;
      let currentCount = 0;
      for (const s of trackInfo.samples) {
        if (s.ctts === currentOffset) {
          currentCount++;
        } else {
          if (currentCount > 0) cttsEntries.push({ count: currentCount, offset: currentOffset });
          currentOffset = s.ctts;
          currentCount = 1;
        }
      }
      if (currentCount > 0) cttsEntries.push({ count: currentCount, offset: currentOffset });

      const cttsPayload = new Uint8Array(4 + cttsEntries.length * 8);
      const cttsView = new DataView(cttsPayload.buffer);
      cttsView.setUint32(0, cttsEntries.length);
      for (let i = 0; i < cttsEntries.length; i++) {
        cttsView.setUint32(4 + i*8, cttsEntries[i].count);
        cttsView.setInt32(8 + i*8, cttsEntries[i].offset);
      }
      cttsBox = FMP4ToMP4Converter.writeFullBox('ctts', 1, 0, cttsPayload);
    }

    // Assemble new stbl
    const boxes = [stsd.data, sttsBox, stscBox, stszBox, stcoBox];
    if (hasCtts) boxes.push(cttsBox);
    const newStblData = FMP4ToMP4Converter.concatBoxes(boxes);
    const newStbl = FMP4ToMP4Converter.writeBox('stbl', newStblData);

    // Replace stbl in minf
    const minfSubs = FMP4ToMP4Converter.parseSubBoxes(minf.data, 8).filter(b => b.type !== 'stbl');
    minfSubs.push({ data: newStbl });
    const newMinfData = FMP4ToMP4Converter.concatBoxes(minfSubs.map(b => b.data));
    const newMinf = FMP4ToMP4Converter.writeBox('minf', newMinfData);

    // Replace minf in mdia
    const mdiaSubs = FMP4ToMP4Converter.parseSubBoxes(mdia.data, 8).filter(b => b.type !== 'minf');
    mdiaSubs.push({ data: newMinf });
    
    // Update mdhd duration
    const mdhdBox = mdiaSubs.find(b => b.type === 'mdhd');
    if (mdhdBox) {
      const view = new DataView(mdhdBox.data.buffer, mdhdBox.data.byteOffset, mdhdBox.data.byteLength);
      const version = view.getUint8(8);
      if (version === 1) {
        view.setBigUint64(32, BigInt(trackInfo.totalDuration));
      } else {
        view.setUint32(24, trackInfo.totalDuration);
      }
    }
    const newMdiaData = FMP4ToMP4Converter.concatBoxes(mdiaSubs.map(b => b.data));
    const newMdia = FMP4ToMP4Converter.writeBox('mdia', newMdiaData);

    // Update tkhd trackId and duration
    const trakSubs = FMP4ToMP4Converter.parseSubBoxes(trakData, 8).filter(b => b.type !== 'mdia');
    const tkhdBox = trakSubs.find(b => b.type === 'tkhd');
    if (tkhdBox) {
      const view = new DataView(tkhdBox.data.buffer, tkhdBox.data.byteOffset, tkhdBox.data.byteLength);
      const version = view.getUint8(8);
      if (version === 1) {
        view.setUint32(28, trackId);
        view.setBigUint64(36, BigInt(trackInfo.totalDuration));
      } else {
        view.setUint32(20, trackId);
        view.setUint32(28, trackInfo.totalDuration);
      }
    }
    
    trakSubs.push({ data: newMdia });
    const newTrakData = FMP4ToMP4Converter.concatBoxes(trakSubs.map(b => b.data));
    return FMP4ToMP4Converter.writeBox('trak', newTrakData);
  }

  static rebuildMoov(moovData, videoTrak, audioTrak) {
    const moovSubs = FMP4ToMP4Converter.parseSubBoxes(moovData, 8).filter(b => b.type !== 'trak' && b.type !== 'mvex');
    
    const newSubs = moovSubs.map(b => b.data);
    newSubs.push(videoTrak);
    if (audioTrak) newSubs.push(audioTrak);
    
    return FMP4ToMP4Converter.writeBox('moov', FMP4ToMP4Converter.concatBoxes(newSubs));
  }

  static concatBoxes(boxes) {
    const totalLen = boxes.reduce((acc, b) => acc + b.length, 0);
    const res = new Uint8Array(totalLen);
    let offset = 0;
    for (const b of boxes) {
      res.set(b, offset);
      offset += b.length;
    }
    return res;
  }

  static createFtyp() {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    // major_brand = isom
    payload[0] = 0x69; payload[1] = 0x73; payload[2] = 0x6F; payload[3] = 0x6D;
    view.setUint32(4, 512); // minor_version
    // compatible_brands = isom, iso2
    payload[8] = 0x69; payload[9] = 0x73; payload[10] = 0x6F; payload[11] = 0x6D;
    payload[12] = 0x69; payload[13] = 0x73; payload[14] = 0x6F; payload[15] = 0x32;
    return FMP4ToMP4Converter.writeBox('ftyp', payload);
  }

  static patchStco(moovBox, trackId, offset) {
    // Traverse to stco of given trackId
    const traks = FMP4ToMP4Converter.parseSubBoxes(moovBox, 8).filter(b => b.type === 'trak');
    for (const trak of traks) {
      const tkhd = FMP4ToMP4Converter.parseSubBoxes(trak.data, 8).find(b => b.type === 'tkhd');
      if (!tkhd) continue;
      const tView = new DataView(tkhd.data.buffer, tkhd.data.byteOffset, tkhd.data.byteLength);
      const tid = tView.getUint8(8) === 1 ? tView.getUint32(28) : tView.getUint32(20);
      if (tid === trackId) {
        const mdia = FMP4ToMP4Converter.parseSubBoxes(trak.data, 8).find(b => b.type === 'mdia');
        const minf = FMP4ToMP4Converter.parseSubBoxes(mdia.data, 8).find(b => b.type === 'minf');
        const stbl = FMP4ToMP4Converter.parseSubBoxes(minf.data, 8).find(b => b.type === 'stbl');
        
        // Find stco exactly inside stbl
        let stblOffset = trak.offset + mdia.offset + minf.offset + stbl.offset;
        let p = 8;
        const view = new DataView(stbl.data.buffer, stbl.data.byteOffset, stbl.data.byteLength);
        while (p < stbl.data.length) {
          const size = view.getUint32(p);
          const type = String.fromCharCode(stbl.data[p+4], stbl.data[p+5], stbl.data[p+6], stbl.data[p+7]);
          if (type === 'stco') {
            // Write exact byte offset into the moovBox ArrayBuffer directly!
            // stco structure: size(4), 'stco', version(1), flags(3), entry_count(4), offset1(4)
            const absoluteStcoDataOffset = stblOffset + p + 16;
            const moovView = new DataView(moovBox.buffer, moovBox.byteOffset, moovBox.byteLength);
            moovView.setUint32(absoluteStcoDataOffset, offset);
            return;
          }
          p += size;
        }
      }
    }
  }
}
