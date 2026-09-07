/**
 * HLS (HTTP Live Streaming) Manifest Parser
 * Parses both Master Playlists and Media Playlists (.m3u8)
 * 
 * Supports:
 * - Master playlist variant stream extraction
 * - Media playlist segment parsing
 * - Audio rendition groups
 * - Initialization segments (#EXT-X-MAP)
 * - Encryption detection (#EXT-X-KEY)
 * - Relative and absolute URL resolution
 */

export class HLSParser {
  /**
   * Parse an HLS manifest string
   * @param {string} content - The raw .m3u8 content
   * @param {string} manifestUrl - The URL the manifest was fetched from (for resolving relative URLs)
   * @returns {object} Parsed manifest object
   */
  static parse(content, manifestUrl) {
    if (!content) {
      throw new Error('Empty HLS manifest response received');
    }
    if (typeof content !== 'string') {
      throw new Error('Invalid HLS manifest content type: expected string');
    }
    const trimmed = content.trim();
    if (trimmed.startsWith('<html') || trimmed.startsWith('<!DOCTYPE') || trimmed.includes('<html') || trimmed.includes('<HTML')) {
      throw new Error('Server returned an HTML error page instead of an HLS playlist (likely HTTP 403 Forbidden or expired session token)');
    }
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<Error') || trimmed.includes('<Code>AccessDenied</Code>') || trimmed.includes('<Error>')) {
      throw new Error('Server returned an XML access denied error (likely HTTP 403 Forbidden or expired CDN token)');
    }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const json = JSON.parse(trimmed);
        if (json.video || json.base_url) {
          return HLSParser.parseJsonManifest(json, manifestUrl);
        }
      } catch (_) {}
      throw new Error('Server returned a JSON response instead of an M3U8 playlist');
    }
    if (!content.includes('#EXTM3U')) {
      throw new Error('Invalid HLS manifest: missing #EXTM3U header');
    }

    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Determine if this is a master playlist or media playlist
    const isMaster = lines.some(l =>
      l.startsWith('#EXT-X-STREAM-INF') || l.startsWith('#EXT-X-MEDIA:')
    );

    if (isMaster) {
      return HLSParser.parseMasterPlaylist(lines, manifestUrl);
    } else {
      return HLSParser.parseMediaPlaylist(lines, manifestUrl);
    }
  }

  /**
   * Parse a Master Playlist containing variant streams
   */
  static parseMasterPlaylist(lines, manifestUrl) {
    const variants = [];
    const audioRenditions = [];
    const subtitleRenditions = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Parse audio/subtitle renditions
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = HLSParser.parseAttributes(line.substring('#EXT-X-MEDIA:'.length));
        const rendition = {
          type: attrs.TYPE,
          groupId: attrs['GROUP-ID'],
          name: attrs.NAME,
          language: attrs.LANGUAGE || null,
          isDefault: attrs.DEFAULT === 'YES',
          autoSelect: attrs.AUTOSELECT === 'YES',
          uri: attrs.URI ? HLSParser.resolveUrl(attrs.URI, manifestUrl) : null,
          channels: attrs.CHANNELS || null
        };

        if (attrs.TYPE === 'AUDIO') {
          audioRenditions.push(rendition);
        } else if (attrs.TYPE === 'SUBTITLES') {
          subtitleRenditions.push(rendition);
        }
      }

      // Parse variant streams
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = HLSParser.parseAttributes(line.substring('#EXT-X-STREAM-INF:'.length));
        const uri = i + 1 < lines.length && !lines[i + 1].startsWith('#') ? lines[i + 1] : null;

        if (uri) {
          const resolution = attrs.RESOLUTION || null;
          let width = null;
          let height = null;
          if (resolution) {
            const parts = resolution.split('x');
            width = parseInt(parts[0]);
            height = parseInt(parts[1]);
          }

          variants.push({
            url: HLSParser.resolveUrl(uri, manifestUrl),
            bandwidth: parseInt(attrs.BANDWIDTH) || 0,
            averageBandwidth: parseInt(attrs['AVERAGE-BANDWIDTH']) || null,
            resolution: resolution,
            width: width,
            height: height,
            codecs: attrs.CODECS || null,
            frameRate: parseFloat(attrs['FRAME-RATE']) || null,
            audioGroup: attrs.AUDIO || null,
            subtitleGroup: attrs.SUBTITLES || null,
            label: HLSParser.buildQualityLabel(height, parseInt(attrs.BANDWIDTH))
          });
          i++; // skip URI line
        }
      }
    }

    // Sort variants by bandwidth (highest first)
    variants.sort((a, b) => b.bandwidth - a.bandwidth);

    return {
      type: 'master',
      variants,
      audioRenditions,
      subtitleRenditions,
      manifestUrl
    };
  }

  /**
   * Parse a Media Playlist containing segments
   */
  static parseMediaPlaylist(lines, manifestUrl) {
    const segments = [];
    let currentDuration = 0;
    let totalDuration = 0;
    let targetDuration = 0;
    let mediaSequence = 0;
    let initSegment = null;
    let encryption = null;
    let isLive = true; // Assume live unless #EXT-X-ENDLIST found
    let currentTitle = '';
    let currentByteRange = null;
    let lastByteOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseInt(line.split(':')[1]);
      }

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.split(':')[1]);
      }

      if (line.startsWith('#EXT-X-ENDLIST')) {
        isLive = false;
      }

      // Initialization segment
      if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = HLSParser.parseAttributes(line.substring('#EXT-X-MAP:'.length));
        initSegment = {
          url: HLSParser.resolveUrl(attrs.URI, manifestUrl),
          byteRange: attrs.BYTERANGE || null
        };
      }

      // Encryption info
      if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = HLSParser.parseAttributes(line.substring('#EXT-X-KEY:'.length));
        encryption = {
          method: attrs.METHOD,
          uri: attrs.URI ? HLSParser.resolveUrl(attrs.URI, manifestUrl) : null,
          iv: attrs.IV || null,
          keyFormat: attrs.KEYFORMAT || null
        };
      }

      // Byte range info (RFC 8216)
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const val = line.substring('#EXT-X-BYTERANGE:'.length).trim();
        const parts = val.split('@');
        const length = parseInt(parts[0]);
        let offset = 0;
        if (parts.length > 1) {
          offset = parseInt(parts[1]);
        } else {
          offset = lastByteOffset;
        }
        lastByteOffset = offset + length;
        currentByteRange = `${length}@${offset}`;
      }

      // Segment duration and title
      if (line.startsWith('#EXTINF:')) {
        const infoStr = line.substring('#EXTINF:'.length);
        const commaIdx = infoStr.indexOf(',');
        currentDuration = parseFloat(commaIdx >= 0 ? infoStr.substring(0, commaIdx) : infoStr);
        currentTitle = commaIdx >= 0 ? infoStr.substring(commaIdx + 1).trim() : '';
      }

      // Segment URI (non-comment, non-empty line after #EXTINF)
      if (!line.startsWith('#') && currentDuration > 0) {
        segments.push({
          url: HLSParser.resolveUrl(line, manifestUrl),
          duration: currentDuration,
          title: currentTitle,
          sequence: mediaSequence + segments.length,
          byteRange: currentByteRange || null,
          encryption: encryption ? { ...encryption } : null
        });
        totalDuration += currentDuration;
        currentDuration = 0;
        currentTitle = '';
        currentByteRange = null;
      }
    }

    return {
      type: 'media',
      segments,
      totalDuration,
      targetDuration,
      mediaSequence,
      initSegment,
      isLive,
      isEncrypted: encryption !== null && encryption.method !== 'NONE',
      encryptionMethod: encryption ? encryption.method : null,
      segmentCount: segments.length,
      manifestUrl
    };
  }

  /**
   * Parse HLS attribute string into key-value pairs
   * Handles quoted and unquoted values
   */
  static parseAttributes(attrString) {
    const attrs = Object.create(null);
    const regex = /([A-Z0-9-]+)=(?:"([^"]*?)"|([^",]*?))(,|$)/g;
    let match;

    while ((match = regex.exec(attrString)) !== null) {
      const key = match[1];
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        attrs[key] = match[2] !== undefined ? match[2] : match[3];
      }
    }

    return attrs;
  }

  /**
   * Resolve a potentially relative URL against a base URL
   */
  static resolveUrl(url, baseUrl) {
    if (!url) return url;
    try {
      // If already absolute
      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (baseUrl) {
          try {
            const urlObj = new URL(url);
            const baseObj = new URL(baseUrl);
            if (urlObj.hostname === baseObj.hostname && baseObj.search && !urlObj.search) {
              urlObj.search = baseObj.search;
              return urlObj.href;
            }
          } catch (_) {}
        }
        return url;
      }

      // Check if baseUrl contains an EdgeAuth or token path prefix
      // e.g. /exp=1725665893~acl=%2F*~hmac=abc/
      let tokenPrefix = '';
      if (baseUrl) {
        try {
          const baseObj = new URL(baseUrl);
          const match = baseObj.pathname.match(/^(\/(?:exp|token|auth|hls|acl)=[^/]+\/)/i) ||
                        baseObj.pathname.match(/^(\/[a-zA-Z0-9_.~-]*exp=[^/]+\/)/i);
          if (match) {
            tokenPrefix = match[1];
          }
        } catch (_) {}
      }

      // If url is root-relative (starts with /) and tokenPrefix exists, preserve tokenPrefix
      let targetUrl = url;
      if (tokenPrefix && url.startsWith('/') && !url.startsWith(tokenPrefix)) {
        targetUrl = tokenPrefix.replace(/\/$/, '') + url;
      }

      const resolved = new URL(targetUrl, baseUrl);
      if (baseUrl) {
        try {
          const baseObj = new URL(baseUrl);
          if (baseObj.search && !resolved.search) {
            resolved.search = baseObj.search;
          }
        } catch (_) {}
      }
      return resolved.href;
    } catch {
      return url;
    }
  }

  /**
   * Parse a JSON manifest (e.g. Vimeo master.json) into master playlist structure
   */
  static parseJsonManifest(json, manifestUrl) {
    const baseUrl = json.base_url ? HLSParser.resolveUrl(json.base_url, manifestUrl) : manifestUrl;
    const variants = [];
    const audioRenditions = [];

    if (Array.isArray(json.video)) {
      for (const v of json.video) {
        const vUrl = v.url ? HLSParser.resolveUrl(v.url, baseUrl) : (v.id ? HLSParser.resolveUrl(String(v.id), baseUrl) : '');
        const segs = Array.isArray(v.segments) ? v.segments.map(s => HLSParser.resolveUrl(s.url || s, baseUrl)) : null;
        const initSegment = v.init_segment ? HLSParser.resolveUrl(v.init_segment, baseUrl) : null;
        variants.push({
          url: vUrl,
          bandwidth: v.avg_bitrate || v.bitrate || 0,
          resolution: v.width && v.height ? `${v.width}x${v.height}` : null,
          width: v.width || 0,
          height: v.height || 0,
          codecs: v.codecs || 'avc1',
          label: HLSParser.buildQualityLabel(v.height, v.avg_bitrate || v.bitrate),
          segments: segs,
          initSegment: initSegment
        });
      }
    }

    if (Array.isArray(json.audio)) {
      for (let i = 0; i < json.audio.length; i++) {
        const a = json.audio[i];
        const aUrl = a.url ? HLSParser.resolveUrl(a.url, baseUrl) : (a.id ? HLSParser.resolveUrl(String(a.id), baseUrl) : '');
        const segs = Array.isArray(a.segments) ? a.segments.map(s => HLSParser.resolveUrl(s.url || s, baseUrl)) : null;
        const initSegment = a.init_segment ? HLSParser.resolveUrl(a.init_segment, baseUrl) : null;
        audioRenditions.push({
          groupId: 'audio',
          name: a.title || a.id || `Audio ${i + 1}`,
          language: a.lang || a.codecs || 'default',
          isDefault: i === 0,
          uri: aUrl,
          segments: segs,
          initSegment: initSegment
        });
      }
    }

    return {
      type: 'master',
      variants,
      audioRenditions,
      subtitleRenditions: []
    };
  }

  /**
   * Build a human-readable quality label
   */
  static buildQualityLabel(height, bandwidth) {
    const labels = [];
    if (height) {
      if (height >= 2160) labels.push('4K');
      else if (height >= 1440) labels.push('1440p');
      else if (height >= 1080) labels.push('1080p');
      else if (height >= 720) labels.push('720p');
      else if (height >= 480) labels.push('480p');
      else if (height >= 360) labels.push('360p');
      else labels.push(`${height}p`);
    }
    if (bandwidth) {
      if (bandwidth >= 1000000) {
        labels.push(`${(bandwidth / 1000000).toFixed(1)} Mbps`);
      } else {
        labels.push(`${Math.round(bandwidth / 1000)} Kbps`);
      }
    }
    return labels.join(' · ') || 'Unknown';
  }
}