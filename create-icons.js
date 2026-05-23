// Quick script to create minimal PNG icons for the extension
// Run: node create-icons.js

const fs = require('fs');
const path = require('path');

// Minimal valid PNG generator (single-color with gradient feel)
function createMinimalPNG(size) {
  // PNG file structure
  const width = size;
  const height = size;

  // Create raw pixel data (RGBA)
  const rawData = Buffer.alloc(height * (1 + width * 4)); // filter byte + RGBA per pixel

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // filter: None

    for (let x = 0; x < width; x++) {
      const pixOffset = rowOffset + 1 + x * 4;
      const t = (x + y) / (width + height);

      // Gradient from indigo to purple
      const r = Math.round(67 + t * (124 - 67));
      const g = Math.round(56 + t * (58 - 56));
      const b = Math.round(202 + t * (237 - 202));

      // Rounded corners
      const cx = width / 2, cy = height / 2;
      const cornerR = size * 0.22;
      let alpha = 255;

      // Check corners
      const corners = [
        [cornerR, cornerR],
        [width - cornerR, cornerR],
        [cornerR, height - cornerR],
        [width - cornerR, height - cornerR]
      ];

      for (const [ccx, ccy] of corners) {
        const inCornerRegion =
          (x < cornerR && y < cornerR && ccx === cornerR && ccy === cornerR) ||
          (x >= width - cornerR && y < cornerR && ccx === width - cornerR && ccy === cornerR) ||
          (x < cornerR && y >= height - cornerR && ccx === cornerR && ccy === height - cornerR) ||
          (x >= width - cornerR && y >= height - cornerR && ccx === width - cornerR && ccy === height - cornerR);

        if (inCornerRegion) {
          const dist = Math.sqrt((x - ccx) ** 2 + (y - ccy) ** 2);
          if (dist > cornerR) alpha = 0;
        }
      }

      // Draw a simple play triangle in center (cyan)
      const triCx = width / 2, triCy = height / 2;
      const triSize = size * 0.25;
      const relX = (x - triCx) / triSize;
      const relY = (y - triCy) / triSize;

      if (relX >= -0.3 && relX <= 0.5 && Math.abs(relY) <= 0.5 - relX * 0.6 && alpha > 0) {
        rawData[pixOffset] = 34;     // R - cyan
        rawData[pixOffset + 1] = 211; // G
        rawData[pixOffset + 2] = 238; // B
        rawData[pixOffset + 3] = alpha;
      } else {
        rawData[pixOffset] = r;
        rawData[pixOffset + 1] = g;
        rawData[pixOffset + 2] = b;
        rawData[pixOffset + 3] = alpha;
      }
    }
  }

  // Compress with deflate (zlib)
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData);

  // Build PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT chunk
  const idat = makeChunk('IDAT', compressed);

  // IEND chunk
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  // CRC32
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < crcData.length; i++) {
    crc ^= crcData[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  crc ^= 0xFFFFFFFF;

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([len, typeBuffer, data, crcBuf]);
}

// Generate icons
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48]) {
  const png = createMinimalPNG(size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`Created icon${size}.png (${png.length} bytes)`);
}

console.log('Done!');
