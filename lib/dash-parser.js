/**
 * DASH (Dynamic Adaptive Streaming over HTTP) MPD Manifest Parser
 * Parses Media Presentation Description (MPD) XML files
 */

export class DASHParser {
  static parse(content, manifestUrl) {
    if (typeof DOMParser === 'undefined') {
      // In service worker context, return a minimal result indicating DASH was detected
      // Full parsing happens in the offscreen document
      return {
        type: 'dash',
        variants: [],
        audioTracks: [],
        subtitleTracks: [],
        isProtected: content.includes('ContentProtection') || content.includes('cenc:'),
        needsOffscreenParsing: true,
        rawContent: content,
        manifestUrl: manifestUrl
      };
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid DASH MPD');

    const mpd = doc.querySelector('MPD');
    if (!mpd) throw new Error('Invalid DASH MPD: missing MPD element');

    const result = {
      type: 'mpd',
      mpdType: mpd.getAttribute('type') || 'static',
      isLive: (mpd.getAttribute('type') || 'static') === 'dynamic',
      totalDuration: DASHParser.parseDuration(mpd.getAttribute('mediaPresentationDuration')),
      periods: [],
      manifestUrl
    };

    const baseUrl = DASHParser.getBaseUrl(mpd, manifestUrl);
    for (const periodEl of mpd.querySelectorAll(':scope > Period')) {
      result.periods.push(DASHParser.parsePeriod(periodEl, baseUrl, result.totalDuration));
    }
    
    result.isProtected = !!doc.querySelector('ContentProtection');
    result.audioTracks = [];
    result.subtitleTracks = [];
    result.periods.forEach(p => {
      p.audioSets.forEach(s => result.audioTracks.push(s));
      const textSets = p.adaptationSets.filter(a => a.contentType === 'text' || a.contentType === 'subtitle');
      textSets.forEach(s => result.subtitleTracks.push(s));
    });
    
    return result;
  }

  static parsePeriod(periodEl, parentBaseUrl, mpdDuration = 0) {
    const baseUrl = DASHParser.getBaseUrl(periodEl, parentBaseUrl);
    const periodDuration = DASHParser.parseDuration(periodEl.getAttribute('duration')) || mpdDuration || 0;
    const adaptationSets = [];
    for (const asEl of periodEl.querySelectorAll(':scope > AdaptationSet')) {
      adaptationSets.push(DASHParser.parseAdaptationSet(asEl, baseUrl, periodDuration));
    }
    return {
      id: periodEl.getAttribute('id'),
      duration: periodDuration,
      adaptationSets,
      videoSets: adaptationSets.filter(a => a.contentType === 'video'),
      audioSets: adaptationSets.filter(a => a.contentType === 'audio'),
    };
  }

  static parseAdaptationSet(asEl, parentBaseUrl, periodDuration = 0) {
    const baseUrl = DASHParser.getBaseUrl(asEl, parentBaseUrl);
    const mimeType = asEl.getAttribute('mimeType') || '';
    const contentType = asEl.getAttribute('contentType') ||
      (mimeType.startsWith('video') ? 'video' : mimeType.startsWith('audio') ? 'audio' : mimeType.startsWith('text') || mimeType.startsWith('application/ttml') ? 'text' : 'unknown');

    const cpElements = asEl.querySelectorAll('ContentProtection');
    const isEncrypted = cpElements.length > 0;

    const segTemplate = asEl.querySelector(':scope > SegmentTemplate');
    const sharedTemplate = segTemplate ? DASHParser.parseSegmentTemplate(segTemplate) : null;

    const representations = [];
    for (const repEl of asEl.querySelectorAll(':scope > Representation')) {
      representations.push(DASHParser.parseRepresentation(repEl, baseUrl, sharedTemplate, contentType, periodDuration));
    }
    representations.sort((a, b) => b.bandwidth - a.bandwidth);

    return {
      id: asEl.getAttribute('id'), contentType, mimeType,
      codecs: asEl.getAttribute('codecs'), lang: asEl.getAttribute('lang'),
      isEncrypted, representations
    };
  }

  static parseRepresentation(repEl, parentBaseUrl, sharedTemplate, contentType, periodDuration = 0) {
    const baseUrl = DASHParser.getBaseUrl(repEl, parentBaseUrl);
    const bandwidth = parseInt(repEl.getAttribute('bandwidth')) || 0;
    const width = parseInt(repEl.getAttribute('width')) || null;
    const height = parseInt(repEl.getAttribute('height')) || null;
    const codecs = repEl.getAttribute('codecs') || null;
    const id = repEl.getAttribute('id') || '';

    let segments = null, initUrl = null;

    const repSegTemplate = repEl.querySelector(':scope > SegmentTemplate');
    const segTemplate = repSegTemplate ? DASHParser.parseSegmentTemplate(repSegTemplate) : sharedTemplate;

    if (segTemplate) {
      const r = DASHParser.buildSegmentsFromTemplate(segTemplate, id, bandwidth, baseUrl, periodDuration);
      segments = r.segments; initUrl = r.initUrl;
    }

    const segList = repEl.querySelector(':scope > SegmentList');
    if (segList) {
      const r = DASHParser.buildSegmentsFromList(segList, baseUrl);
      segments = r.segments; initUrl = r.initUrl;
    }

    if (!segments) segments = [{ url: baseUrl, duration: 0 }];

    return {
      id, bandwidth, width, height, codecs, baseUrl, initUrl, segments,
      segmentCount: segments.length,
      label: DASHParser.buildLabel(contentType, height, bandwidth, codecs)
    };
  }

  static parseSegmentTemplate(el) {
    const t = {
      media: el.getAttribute('media'),
      initialization: el.getAttribute('initialization'),
      startNumber: parseInt(el.getAttribute('startNumber')) || 1,
      timescale: parseInt(el.getAttribute('timescale')) || 1,
      duration: parseInt(el.getAttribute('duration')) || 0,
      timeline: []
    };
    const tl = el.querySelector('SegmentTimeline');
    if (tl) for (const s of tl.querySelectorAll('S')) {
      t.timeline.push({ t: parseInt(s.getAttribute('t')) || null, d: parseInt(s.getAttribute('d')) || 0, r: parseInt(s.getAttribute('r')) || 0 });
    }
    return t;
  }

  static buildSegmentsFromTemplate(template, repId, bw, baseUrl, periodDuration = 0) {
    const segments = [];
    let initUrl = null;
    if (template.initialization) {
      initUrl = DASHParser.resolveUrl(DASHParser.sub(template.initialization, repId, bw, 0, 0), baseUrl);
    }
    if (template.timeline.length > 0) {
      let num = template.startNumber, time = 0;
      for (let sIdx = 0; sIdx < template.timeline.length; sIdx++) {
        const s = template.timeline[sIdx];
        if (s.t !== null) time = s.t;
        if (s.r < 0) {
          // r=-1 means repeat until next S element or end of period
          const nextT = (sIdx + 1 < template.timeline.length) ? template.timeline[sIdx + 1].t : null;
          if (nextT !== null) {
            s.r = Math.ceil((nextT - time) / s.d) - 1;
          } else if (periodDuration > 0) {
            s.r = Math.ceil((periodDuration * template.timescale - time) / s.d) - 1;
          } else {
            s.r = 0;
          }
        }
        for (let j = 0; j <= s.r; j++) {
          segments.push({ url: DASHParser.resolveUrl(DASHParser.sub(template.media, repId, bw, num, time), baseUrl), duration: s.d / template.timescale });
          time += s.d; num++;
        }
      }
    } else if (template.duration > 0) {
      const segDuration = template.duration / template.timescale;
      const effectiveDuration = periodDuration || 0;
      const count = (effectiveDuration > 0 && segDuration > 0) ? Math.ceil(effectiveDuration / segDuration) : 0;
      for (let i = 0; i < count; i++) {
        const num = template.startNumber + i;
        segments.push({ url: DASHParser.resolveUrl(DASHParser.sub(template.media, repId, bw, num, i * template.duration), baseUrl), duration: segDuration });
      }
    }
    return { segments, initUrl };
  }

  static buildSegmentsFromList(segListEl, baseUrl) {
    const segments = [];
    let initUrl = null;
    const initEl = segListEl.querySelector('Initialization');
    if (initEl) initUrl = DASHParser.resolveUrl(initEl.getAttribute('sourceURL'), baseUrl);
    const dur = parseInt(segListEl.getAttribute('duration')) || 0;
    const ts = parseInt(segListEl.getAttribute('timescale')) || 1;
    for (const su of segListEl.querySelectorAll('SegmentURL')) {
      segments.push({ url: DASHParser.resolveUrl(su.getAttribute('media'), baseUrl), duration: dur / ts });
    }
    return { segments, initUrl };
  }

  static sub(tpl, repId, bw, num, time) {
    if (!tpl) return tpl;
    return tpl.replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, bw)
      .replace(/\$Number(%\d+d)?\$/g, (m, f) => f ? String(num).padStart(parseInt(f.slice(1, -1)), '0') : num)
      .replace(/\$Time(%\d+d)?\$/g, (m, f) => f ? String(time).padStart(parseInt(f.slice(1, -1)), '0') : time)
      .replace(/\$\$/g, '$');
  }

  static getBaseUrl(el, parentBaseUrl) {
    const bu = el.querySelector(':scope > BaseURL');
    if (bu) {
      const t = bu.textContent.trim();
      return t.startsWith('http') ? t : DASHParser.resolveUrl(t, parentBaseUrl);
    }
    return parentBaseUrl;
  }

  static resolveUrl(url, baseUrl) {
    if (!url) return url;
    try { return url.startsWith('http') ? url : new URL(url, baseUrl).href; } catch { return url; }
  }

  static parseDuration(s) {
    if (!s) return 0;
    const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
    return m ? (parseInt(m[1]) || 0) * 3600 + (parseInt(m[2]) || 0) * 60 + (parseFloat(m[3]) || 0) : 0;
  }

  static buildLabel(type, height, bw, codecs) {
    const l = [];
    if (type === 'video' && height) {
      l.push(height >= 2160 ? '4K' : height >= 1440 ? '1440p' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 480 ? '480p' : `${height}p`);
    }
    if (type === 'audio' && codecs) {
      l.push(codecs.includes('mp4a') ? 'AAC' : codecs.includes('opus') ? 'Opus' : codecs);
    }
    if (bw) l.push(bw >= 1e6 ? `${(bw / 1e6).toFixed(1)} Mbps` : `${Math.round(bw / 1e3)} Kbps`);
    return l.join(' · ') || 'Unknown';
  }
}