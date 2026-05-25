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
  }

  /**
   * Download all segments
   * @param {Array<{url: string}>} segments
   * @param {string|null} initUrl - Optional initialization segment URL
   * @returns {Promise<{init: ArrayBuffer|null, segments: ArrayBuffer[]}>}
   */
  async downloadAll(segments, initUrl = null) {
    let init = null;
    if (initUrl) {
      init = await this.fetchWithRetry(initUrl);
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
          const buf = await this.fetchWithRetry(item.seg.url);
          results[item.idx] = buf;
          this.bytesDownloaded += buf.byteLength;
          completed++;
          const elapsed = (Date.now() - this.startTime) / 1000;
          const speed = elapsed > 0 ? this.bytesDownloaded / elapsed : 0;
          this.onProgress({
            completed,
            total,
            percent: Math.round((completed / total) * 100),
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
  async fetchWithRetry(url, attempt = 0) {
    try {
      const response = await fetch(url, {
        signal: this.abortController.signal,
        mode: 'cors',
        credentials: 'omit'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (err) {
      if (this.abortController.signal.aborted) throw err;
      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, this.retryDelay * Math.pow(2, attempt)));
        return this.fetchWithRetry(url, attempt + 1);
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
