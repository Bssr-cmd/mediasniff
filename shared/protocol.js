// shared/protocol.js
// Core message type constants and helper utilities for MediaSniff

export const MSG_TYPE = {
  DETECT: 'DETECT',
  DOWNLOAD: 'DOWNLOAD',
  PROGRESS: 'PROGRESS',
  RESULT: 'RESULT',
  ERROR: 'ERROR',
};

/**
 * Generate a stable deterministic mediaId based on source and URL.
 * Strips query string and hash for stability.
 * @param {string} source - e.g., 'direct', 'hls', 'dash', 'youtube', 'vimeo', etc.
 * @param {string} url - media URL.
 * @returns {string} mediaId
 */
export function generateMediaId(source, url) {
  try {
    const u = new URL(url);
    // Preserve essential query params that identify unique media
    const essentialParams = ['v', 'id', 'list', 'h', 'itag'];
    const newSearch = new URLSearchParams();
    for (const param of essentialParams) {
      if (u.searchParams.has(param)) {
        newSearch.set(param, u.searchParams.get(param));
      }
    }
    u.search = newSearch.toString();
    u.hash = '';
    return `${source}:${u.toString()}`;
  } catch (_) {
    return `${source}:${url}`;
  }
}
