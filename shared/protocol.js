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
    u.search = '';
    u.hash = '';
    const normalized = u.toString();
    return `${source}:${normalized}`;
  } catch (_) {
    // Fallback for malformed URLs
    return `${source}:${url}`;
  }
}

/** Simple validation of protocol messages */
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const { type, mediaId } = msg;
  if (!type || !mediaId) return false;
  if (!Object.values(MSG_TYPE).includes(type)) return false;
  return true;
}
