/**
 * Concurrent Segment Downloader
 * Downloads media segments with parallelism, retries, and progress reporting.
 */

export class SegmentDownloader {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 8;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.abortController = new AbortController();
    this.onProgress = options.onProgress || (() => { });
    this.bytesDownloaded = 0;
    this.startTime = 0;
    this.referer = options.referer || null;
  }

  /**
   * Download all segments
   * @param {Array<{url: string}>} segments
   * @param {string|null} initUrl - Optional initialization segment URL
   * @returns {Promise<{init: ArrayBuffer|null, segments: ArrayBuffer[]}>}
   */
  async downloadAll(segments, initUrl = null) {
    if (!segments || segments.length === 0) {
      return { init: null, segments: [] };
    }

    let init = null;
    if (initUrl) {
      const initActualUrl = typeof initUrl === 'object' ? initUrl.url : initUrl;
      const initByteRange = typeof initUrl === 'object' ? initUrl.byteRange : null;
      if (typeof initActualUrl === 'string' && initActualUrl.startsWith('data:')) {
        try {
          const commaIdx = initActualUrl.indexOf(',');
          const b64 = commaIdx !== -1 ? initActualUrl.slice(commaIdx + 1) : initActualUrl;
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          init = bytes.buffer;
        } catch (_) {
          init = await this.fetchWithRetry(initActualUrl, initByteRange);
        }
      } else if (typeof initActualUrl === 'string' && !initActualUrl.startsWith('http://') && !initActualUrl.startsWith('https://') && !initActualUrl.startsWith('/') && initActualUrl.length > 50 && !initActualUrl.includes(' ')) {
        const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(initActualUrl) && initActualUrl.length % 4 === 0;
        if (isBase64) {
          try {
            const bin = atob(initActualUrl);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            init = bytes.buffer;
          } catch (_) {
            init = await this.fetchWithRetry(new URL(initActualUrl, this.referer || undefined).href, initByteRange);
          }
        } else {
          init = await this.fetchWithRetry(new URL(initActualUrl, this.referer || undefined).href, initByteRange);
        }
      } else {
        init = await this.fetchWithRetry(initActualUrl, initByteRange);
      }
    }

    const results = new Array(segments.length);
    let completed = 0;
    const total = segments.length;
    this.bytesDownloaded = 0;
    this.startTime = Date.now();

    // Create work queue
    const queue = segments.map((seg, idx) => ({ seg, idx }));
    let queueIdx = 0;

    const worker = async () => {
      while (queueIdx < queue.length) {
        const item = queue[queueIdx++];
        if (!item) break;
        try {
          const segUrl = typeof item.seg === 'string' ? item.seg : item.seg?.url;
          if (!segUrl) {
            throw new Error(`Invalid segment at index ${item.idx}: URL is missing`);
          }
          const byteRange = typeof item.seg === 'object' ? (item.seg.byteRange || item.seg.encryption?.byteRange) : null;
          const buf = await this.fetchWithRetry(segUrl, byteRange);
          results[item.idx] = buf;
          this.bytesDownloaded += buf.byteLength;
          completed++;
          const elapsed = (Date.now() - this.startTime) / 1000;
          const speed = elapsed > 0 ? this.bytesDownloaded / elapsed : 0;
          this.onProgress({
            completed,
            total,
            percent: total > 0 ? Math.round((completed / total) * 100) : 100,
            currentSegment: item.idx,
            bytesDownloaded: this.bytesDownloaded,
            speed,
            speedLabel: formatSpeed(speed)
          });
        } catch (err) {
          if (this.abortController.signal.aborted) throw new Error('Download aborted');
          throw err;
        }
      }
    };

    // Launch concurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(this.concurrency, segments.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return { init, segments: results };
  }

  /**
   * Fetch a single URL with retry logic
   */
  async fetchWithRetry(url, byteRange = null, attempt = 0) {
    try {
      const headers = {};
      if (byteRange) {
        if (typeof byteRange === 'string') {
          let rangeStart, rangeEnd;
          if (byteRange.includes('@')) {
            const parts = byteRange.split('@');
            const length = parseInt(parts[0]);
            const offset = parts.length > 1 ? parseInt(parts[1]) : 0;
            rangeStart = offset;
            rangeEnd = offset + length - 1;
          } else if (byteRange.includes('-')) {
            const parts = byteRange.split('-');
            rangeStart = parseInt(parts[0]);
            rangeEnd = parseInt(parts[1]);
          }
          if (rangeStart !== undefined && rangeEnd !== undefined && !isNaN(rangeStart) && !isNaN(rangeEnd)) {
            headers['Range'] = `bytes=${rangeStart}-${rangeEnd}`;
          }
        } else if (byteRange.length !== undefined) {
          const offset = byteRange.offset || 0;
          headers['Range'] = `bytes=${offset}-${offset + byteRange.length - 1}`;
        }
      }
      const response = await fetch(url, {
        signal: this.abortController.signal,
        headers,
        credentials: 'include'
        // Note: Referer must be set via declarativeNetRequest (DNR) rules, not here.
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (err) {
      if (this.abortController.signal.aborted) throw err;
      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, this.retryDelay * Math.pow(2, attempt)));
        return this.fetchWithRetry(url, byteRange, attempt + 1);
      }
      throw new Error(`Failed to download ${url} after ${this.maxRetries} retries: ${err.message}`);
    }
  }

  abort() {
    this.abortController.abort();
  }
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}
