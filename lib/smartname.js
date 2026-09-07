/**
 * MediaSniff — Smart File Naming Engine
 * Template-based filename generation with per-domain rules.
 */
export class SmartName {
  static defaults = {
    template: '%title',
    maxLength: 120,
    sanitize: true
  };

  /**
   * Generate a smart filename for a media item.
   * @param {Object} item - Media item with url, title, type, quality, etc.
   * @param {string} pageTitle - The page title from the active tab
   * @param {string} pageUrl - The page URL
   * @param {Object} [rules] - Optional per-domain rules
   * @returns {string} Sanitized filename with extension
   */
  static generate(item, pageTitle, pageUrl, rules = null) {
    let template = SmartName.defaults.template;
    let maxLength = SmartName.defaults.maxLength;
    let directory = '';

    // Apply domain-specific rules
    if (rules && pageUrl) {
      try {
        const hostname = new URL(pageUrl).hostname;
        for (const rule of rules) {
          if (hostname.includes(rule.domain)) {
            if (rule.template) template = rule.template;
            if (rule.maxLength) maxLength = rule.maxLength;
            if (rule.directory) directory = rule.directory;
            break; // First match wins
          }
        }
      } catch (_) { }
    }

    // Resolve template variables
    let name = template
      .replace(/%title/g, SmartName._cleanTitle(pageTitle, pageUrl) || 'Untitled')
      .replace(/%hostname/g, SmartName._getHostname(pageUrl))
      .replace(/%quality/g, item.quality || item.resolution || '')
      .replace(/%resolution/g, item.resolution || item.quality || '')
      .replace(/%type/g, item.type || 'media')
      .replace(/%date/g, new Date().toISOString().split('T')[0])
      .replace(/%id/g, item.videoId || item.id || '');

    // Get extension from item
    const ext = SmartName._getExtension(item);

    // Sanitize
    name = SmartName.sanitize(name, maxLength, ext);

    return directory ? `${directory}/${name}` : name;
  }

  /**
   * Clean a page title for use as filename.
   */
  static _cleanTitle(title, pageUrl) {
    if (!title) return '';
    return title
      .replace(/\s*[-–—|]\s*(YouTube|Vimeo|Dailymotion|Twitch|Facebook|Twitter|X|TikTok|Instagram|Reddit).*$/i, '')
      .replace(/\s*[-–—|]\s*Watch.*$/i, '')
      .replace(/\s*[-–—|]\s*Official.*$/i, '')
      .trim();
  }

  static _getHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  static _getExtension(item) {
    if (item.ext) return item.ext;
    if (item.type === 'hls' || item.type === 'dash') return '.mp4';
    if (item.mimeType?.includes('webm')) return '.webm';
    if (item.mimeType?.includes('mp3') || item.mimeType?.includes('mpeg')) return '.mp3';
    if (item.url) {
      const match = item.url.match(/\.(mp4|webm|mkv|avi|mov|mp3|aac|ogg|flac)(\?|#|$)/i);
      if (match) return '.' + match[1].toLowerCase();
    }
    return '.mp4';
  }

  /**
   * Sanitize a filename for Windows/Mac/Linux compatibility.
   */
  static sanitize(name, maxLength = 120, ext = '') {
    // Remove invalid filesystem characters
    name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
    // Remove Windows reserved names
    name = name.replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '_$1');
    // Remove trailing dots and spaces (Windows)
    name = name.replace(/[.\s]+$/, '');
    // Remove leading dots (hidden files on Unix)
    name = name.replace(/^\.+/, '');
    // Collapse multiple spaces/underscores
    name = name.replace(/\s+/g, ' ').replace(/_{2,}/g, '_').trim();
    // Truncate while preserving extension
    if (!name) name = 'download';
    const maxStem = maxLength - ext.length;
    if (name.length > maxStem) {
      name = name.substring(0, maxStem).trim();
    }
    return name + ext;
  }
}
