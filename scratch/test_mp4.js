const fs = require('fs');

class FMP4ToMP4Converter {
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
}

// Mock stsc
const stscPayload = new Uint8Array(16);
const stscView = new DataView(stscPayload.buffer);
stscView.setUint32(0, 1); // entry_count = 1
stscView.setUint32(4, 1); // first_chunk
stscView.setUint32(8, 10); // samples_per_chunk
stscView.setUint32(12, 1); // sample_description_index
const newStsc = FMP4ToMP4Converter.writeFullBox('stsc', 0, 0, stscPayload);

// Mock stco
const stcoPayload = new Uint8Array(8);
const stcoView = new DataView(stcoPayload.buffer);
stcoView.setUint32(0, 1);
stcoView.setUint32(4, 100); // chunk offset
const newStco = FMP4ToMP4Converter.writeFullBox('stco', 0, 0, stcoPayload);

console.log("stsc:", newStsc);
console.log("stco:", newStco);
