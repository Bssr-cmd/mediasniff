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
    if (!content || !content.includes('#EXTM3U')) {
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
          encryption: encryption ? { ...encryption } : null
        });
        totalDuration += currentDuration;
        currentDuration = 0;
        currentTitle = '';
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
      // If already absolute, return as-is
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
      }
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
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