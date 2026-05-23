/**
 * Transmuxer / Merger
 * Merges downloaded segments into a single downloadable file.
 * Handles MPEG-TS concatenation and fMP4 segment assembly.
 */

export class Transmuxer {
  /**
   * Merge segments into a single file
   * @param {ArrayBuffer|null} initSegment - Initialization segment (for fMP4)
   * @param {ArrayBuffer[]} segments - Ordered media segments
   * @param {string} format - 'ts', 'mp4', or 'auto'
   * @returns {Blob} Merged file as a Blob
   */
  static merge(initSegment, segments, format = 'auto') {
    if (format === 'auto') {
      format = Transmuxer.detectFormat(initSegment, segments[0]);
    }

    const parts = [];

    if (format === 'mp4' || format === 'fmp4') {
      // fMP4: init segment + media segments
      if (initSegment) parts.push(initSegment);
      for (const seg of segments) {
        if (seg) parts.push(seg);
      }
      return new Blob(parts, { type: 'video/mp4' });
    }

    // TS or unknown: simple concatenation
    for (const seg of segments) {
      if (seg) parts.push(seg);
    }

    const mimeType = format === 'ts' ? 'video/mp2t' : 'video/mp4';
    return new Blob(parts, { type: mimeType });
  }

  /**
   * Detect segment format by examining magic bytes
   */
  static detectFormat(initSegment, firstSegment) {
    const buf = initSegment || firstSegment;
    if (!buf || buf.byteLength < 8) return 'ts';

    const view = new DataView(buf);

    // Check for ISO BMFF / fMP4 (ftyp or styp box)
    const boxType = String.fromCharCode(
      view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
    );
    if (boxType === 'ftyp' || boxType === 'styp' || boxType === 'moov' || boxType === 'moof') {
      return 'mp4';
    }

    // Check for MPEG-TS sync byte (0x47)
    if (view.getUint8(0) === 0x47) {
      return 'ts';
    }

    return 'ts'; // default fallback
  }

  /**
   * Calculate total size of segments
   */
  static calculateTotalSize(initSegment, segments) {
    let total = initSegment ? initSegment.byteLength : 0;
    for (const seg of segments) {
      if (seg) total += seg.byteLength;
    }
    return total;
  }

  /**
   * Format bytes to human-readable string
   */
  static formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, exp)).toFixed(1)} ${units[exp]}`;
  }
}
