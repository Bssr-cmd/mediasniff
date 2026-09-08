// shared/protocol.js
// Core message type constants and helper utilities for MediaSniff

export const MSG_TYPE = {
  DETECT: 'DETECT',
  DOWNLOAD: 'DOWNLOAD',
  PROGRESS: 'PROGRESS',
  RESULT: 'RESULT',
  ERROR: 'ERROR',
};

export const ERROR_TYPE = {
  NATIVE_UNAVAILABLE: 'NATIVE_UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  AUTH_FAILURE: 'AUTH_FAILURE',
  DRM_PROTECTED: 'DRM_PROTECTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN'
};

export function classifyError(errorMsg, rawError = null) {
  const text = (String(errorMsg || '') + ' ' + String(rawError || '')).toLowerCase();
  
  if (text.includes('permission') || text.includes('not granted')) {
    return {
      type: ERROR_TYPE.PERMISSION_DENIED,
      message: 'Native messaging permission not granted.'
    };
  }
  if (text.includes('host not found') || text.includes('not connected') || text.includes('not installed') || text.includes('disconnected') || text.includes('cannot connect')) {
    return {
      type: ERROR_TYPE.NATIVE_UNAVAILABLE,
      message: 'Native companion app is not installed or not running.'
    };
  }
  if (text.includes('401') || text.includes('403') || text.includes('auth') || text.includes('forbidden') || text.includes('unauthorized') || text.includes('login') || text.includes('sign in')) {
    return {
      type: ERROR_TYPE.AUTH_FAILURE,
      message: 'Authentication failed or stream requires active login.'
    };
  }
  if (text.includes('drm') || text.includes('sample-aes') || text.includes('widevine') || text.includes('playready') || text.includes('fairplay') || text.includes('copyright') || text.includes('protected content')) {
    return {
      type: ERROR_TYPE.DRM_PROTECTED,
      message: 'Media stream is encrypted or DRM-protected.'
    };
  }
  if (text.includes('cancel') || text.includes('abort')) {
    return {
      type: ERROR_TYPE.CANCELLED,
      message: 'Download was cancelled by user.'
    };
  }
  if (text.includes('net::') || text.includes('failed to fetch') || text.includes('network') || text.includes('timeout') || text.includes('econnrefused')) {
    return {
      type: ERROR_TYPE.NETWORK_ERROR,
      message: 'Network connection error or request timed out.'
    };
  }
  return {
    type: ERROR_TYPE.UNKNOWN,
    message: errorMsg || 'Download failed.'
  };
}

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
