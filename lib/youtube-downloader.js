/**
 * MediaSniff — YouTube Downloader
 * 
 * Features:
 * 1. Direct YouTube watch page scraping.
 * 2. Static signature deciphering interpreter (MV3 CSP compliant, eval-free).
 * 3. Fallback proxy resolution via dynamic Invidious and Piped APIs.
 */

function parseCipher(cipherStr) {
  const params = {};
  const parts = cipherStr.split('&');
  for (const part of parts) {
    const equalIdx = part.indexOf('=');
    if (equalIdx > 0) {
      const key = decodeURIComponent(part.substring(0, equalIdx));
      const val = decodeURIComponent(part.substring(equalIdx + 1));
      params[key] = val;
    }
  }
  return {
    url: params.url,
    s: params.s,
    sp: params.sp || 'sig'
  };
}

export class YouTubeDownloader {
  // Fallback Invidious API instances in case tracker is offline
  static INVIDIOUS_INSTANCES = [
    'https://invidious.jing.rocks',
    'https://invidious.nerdvpn.de',
    'https://invidious.lunar.icu',
    'https://yewtu.be',
    'https://invidious.projectsegfaut.de',
    'https://inv.nadeko.net',
    'https://vid.puffyan.us',
    'https://invidious.privacyredirect.com',
    'https://iv.nbooo.com',
  ];

  // Piped API instances (alternative)
  static PIPED_INSTANCES = [
    // External API endpoints removed — defunct services
    'https://api.piped.privacydev.net',
  ];

  static _decipherCache = null;

  // Cobalt API instances (final fallback)
  static COBALT_INSTANCES = [
    'https://api.cobalt.tools',
    'https://cobalt-api.kwiatekmiki.com',
  ];

  /**
   * Dynamically fetch healthy Invidious instances from the official tracker
   */
  static async fetchActiveInstances() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const resp = await fetch('https://api.invidious.io/instances.json?sort_by=type,api,users', {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeout);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const instances = await resp.json();

      const working = [];
      for (const [domain, info] of instances) {
        if (info.type === 'https' && info.monitor && info.monitor.down === false) {
          working.push({
            uri: info.uri || `https://${domain}`,
            uptime: info.monitor.uptime || 0
          });
        }
      }

      // Sort by uptime descending
      working.sort((a, b) => b.uptime - a.uptime);
      return working.map(w => w.uri);
    } catch (e) {
      console.warn('[MediaSniff] Failed to fetch dynamic Invidious instances, using fallbacks:', e.message);
      return [];
    }
  }

  /**
   * YouTube Innertube API — tries multiple client configurations.
   * The TVHTML5_SIMPLY_EMBEDDED_PLAYER client often returns direct URLs without signature.
   */
  static async getInnertubeStreams(videoId) {
    const clients = [
      {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        clientScreen: 'EMBED',
        hl: 'en',
        gl: 'US',
      },
      {
        clientName: 'WEB',
        clientVersion: '2.20260602.06.00',
        hl: 'en',
        gl: 'US',
      },
      {
        clientName: 'IOS',
        clientVersion: '20.21.6',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.5.0.22F76',
        hl: 'en',
        gl: 'US',
      },
      {
        clientName: 'ANDROID',
        clientVersion: '20.21.38',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        hl: 'en',
        gl: 'US',
      },
    ];

    for (const client of clients) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const body = {
          videoId,
          context: {
            client,
            ...(client.clientScreen === 'EMBED' ? {
              thirdParty: { embedUrl: 'https://www.google.com' }
            } : {}),
          },
          playbackContext: {
            contentPlaybackContext: { signatureTimestamp: 0 }
          },
          contentCheckOk: true,
          racyCheckOk: true,
        };

        const headers = {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': client.clientName === 'IOS' ? '5' : client.clientName === 'ANDROID' ? '3' : client.clientName === 'WEB' ? '1' : '85',
          'X-YouTube-Client-Version': client.clientVersion,
        };
        // User-Agent must be set via declarativeNetRequest rules for MV3 compliance

        console.log(`[YouTubeDownloader] Trying innertube client: ${client.clientName}`);
        const resp = await fetch(
          'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);

        if (!resp.ok) {
          console.warn(`[YouTubeDownloader] Innertube ${client.clientName}: HTTP ${resp.status}`);
          continue;
        }

        const data = await resp.json();
        if (data.playabilityStatus?.status !== 'OK') {
          console.warn(`[YouTubeDownloader] Innertube ${client.clientName}: playability ${data.playabilityStatus?.status}`);
          continue;
        }

        const streamingData = data.streamingData;
        if (!streamingData) continue;

        const adaptiveFormats = streamingData.adaptiveFormats || [];
        const formats = streamingData.formats || [];
        const allFormats = [...adaptiveFormats, ...formats];

        // Check if we have any formats with direct URLs (no cipher)
        const hasDirectUrls = allFormats.some(f => f.url && !f.signatureCipher && !f.cipher);
        if (!hasDirectUrls && allFormats.length === 0) continue;

        console.log(`[YouTubeDownloader] Innertube ${client.clientName}: got ${allFormats.length} formats, directUrls=${hasDirectUrls}`);
        return {
          playerResponse: data,
          jsUrl: null, // innertube doesn't provide JS URL, but direct URLs shouldn't need decipher
          clientName: client.clientName,
        };
      } catch (e) {
        console.warn(`[YouTubeDownloader] Innertube ${client.clientName} failed:`, e.message);
      }
    }
    return null;
  }

  /**
   * Cobalt.tools API — open-source video download service
   */
  static async getCobaltUrl(videoUrl, quality = '1080') {
    for (const instance of this.COBALT_INSTANCES) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        console.log(`[YouTubeDownloader] Trying cobalt instance: ${instance}`);
        const resp = await fetch(instance, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: videoUrl,
            videoQuality: quality,
            filenameStyle: 'pretty',
            downloadMode: 'auto',
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          console.warn(`[YouTubeDownloader] Cobalt ${instance}: HTTP ${resp.status}`);
          continue;
        }

        const data = await resp.json();
        if (data.status === 'tunnel' || data.status === 'redirect') {
          console.log(`[YouTubeDownloader] Cobalt resolved: ${data.status}`);
          return {
            url: data.url,
            filename: data.filename || null,
            isCombined: true,
          };
        } else if (data.status === 'picker' && data.picker?.length > 0) {
          // Multiple options — pick the first video
          const videoItem = data.picker.find(p => p.type === 'video') || data.picker[0];
          return {
            url: videoItem.url,
            filename: data.filename || null,
            isCombined: true,
          };
        }
        console.warn(`[YouTubeDownloader] Cobalt ${instance}: unexpected status ${data.status}`);
      } catch (e) {
        console.warn(`[YouTubeDownloader] Cobalt ${instance} failed:`, e.message);
      }
    }
    return null;
  }

  /**
   * Directly scrape YouTube watch page and retrieve player config & JS assets
   */
  static async getDirectStreams(videoId) {
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`;
      console.log(`[YouTubeDownloader] Scrape request: ${url}`);
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();

      // 1. Extract ytInitialPlayerResponse JSON
      const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|script)/)
        || html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/)
        || html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/);

      if (!playerResponseMatch) {
        throw new Error('ytInitialPlayerResponse not found in page source');
      }

      const playerResponse = JSON.parse(playerResponseMatch[1]);
      const streamingData = playerResponse.streamingData;
      const videoDetails = playerResponse.videoDetails;

      if (!streamingData) {
        throw new Error('No streamingData found in player response');
      }

      // 2. Extract player JS asset URL
      const assetsMatch = html.match(/"jsUrl"\s*:\s*"([^"]+)"/)
        || html.match(/href="([^"]+base\.js)"/)
        || html.match(/"assets"\s*:\s*\{\s*"js"\s*:\s*"([^"]+)"/)
        || html.match(/\/s\/player\/[a-zA-Z0-9_-]+\/player_ias\.vflset\/[a-zA-Z0-9_/-]+\/base\.js/);

      let jsUrl = null;
      if (assetsMatch) {
        jsUrl = assetsMatch[1] || assetsMatch[0];
        if (jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
        else if (jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;
      }

      return { playerResponse, jsUrl };
    } catch (e) {
      console.warn('[YouTubeDownloader] Scrape failed:', e.message);
      return null;
    }
  }

  /**
   * Parses base.js to dynamically rebuild the decipher function without eval/new Function.
   *
   * Supports two extraction pipelines:
   *   Pipeline C (primary):  2026/06+ c-array + Nx-style helper + iv/Ta XOR-obfuscated decipher
   *   Pipeline B (fallback): Classic dot-notation split("") → helper.method(a,N) → join("")
   */
  static async getDecipherFunction(jsUrl) {
    if (this._decipherCache && this._decipherCache.jsUrl === jsUrl) {
      return this._decipherCache.decipher;
    }

    if (!jsUrl) return null;

    try {
      console.log('[YouTubeDownloader] Fetching player JS asset:', jsUrl);
      const resp = await fetch(jsUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const js = await resp.text();

      // ─── Pipeline C: c-array + Nx-style helper + iv/Ta XOR decipher (2026/06+) ───
      try {
        console.log('[YouTubeDownloader] Attempting Pipeline C (c-array XOR decipher)...');

        // 1. Extract the global `c` array — defined near the top of base.js as:
        //    var c = "str1{str2{str3{...".split("{")  OR  c = "...".split("{")
        //    The separator can be { or ; depending on the build.
        const cArrayMatch = js.match(/(?:var\s+)?c\s*=\s*"([^"]{100,})"/)
          || js.match(/(?:var\s+)?c\s*=\s*'([^']{100,})'/);
        if (!cArrayMatch) throw new Error('c-array not found');

        // Detect separator from the .split() call following the string
        const cContext = js.substring(cArrayMatch.index, cArrayMatch.index + cArrayMatch[0].length + 30);
        const sepMatch = cContext.match(/\.split\(\s*"([^"]*)"/);
        const sep = sepMatch ? sepMatch[1] : '{';
        const cArray = cArrayMatch[1].split(sep);
        console.log(`[YouTubeDownloader] c-array: ${cArray.length} elements, sep='${sep}'`);

        // Identify key c-array indices for operations
        const spliceIdx = cArray.indexOf('splice');
        const reverseIdx = cArray.indexOf('reverse');
        const lengthIdx = cArray.indexOf('length');
        const splitIdx = cArray.indexOf('split');
        const joinIdx = cArray.indexOf('join');
        if (spliceIdx === -1 || reverseIdx === -1 || lengthIdx === -1) {
          throw new Error('c-array missing required method names');
        }
        console.log(`[YouTubeDownloader] c-array indices: splice=${spliceIdx}, reverse=${reverseIdx}, length=${lengthIdx}, split=${splitIdx}, join=${joinIdx}`);

        // 2. Find the helper object (e.g. Nx) — it's an object whose methods
        //    reference c[spliceIdx], c[reverseIdx], c[lengthIdx] for the three
        //    classic operations (splice, reverse, swap).
        //    Pattern: Nx={name1:function(R,K){...R[0]...R[K%R[c[lengthIdx]]]...}, name2:function(R){R[c[reverseIdx]]()}, name3:function(R,K){R[c[spliceIdx]](0,K)}}
        const helperRegex = new RegExp(
          `([a-zA-Z0-9$_]+)\\s*=\\s*\\{\\s*` +
          `([a-zA-Z0-9$_]+)\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{[^}]*c\\[${lengthIdx}\\][^}]*\\}\\s*,\\s*` +
          `([a-zA-Z0-9$_]+)\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{[^}]*c\\[${reverseIdx}\\][^}]*\\}\\s*,\\s*` +
          `([a-zA-Z0-9$_]+)\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{[^}]*c\\[${spliceIdx}\\][^}]*\\}`
        );
        // Also try reverse order: splice, swap, reverse  OR  splice, reverse, swap etc.
        let helperMatch = js.match(helperRegex);

        // If the first regex didn't match, try a more flexible approach:
        // Find any object with exactly 3 methods that reference c[spliceIdx], c[reverseIdx], c[lengthIdx]
        if (!helperMatch) {
          const flexRegex = new RegExp(
            `([a-zA-Z0-9$_]+)\\s*=\\s*\\{\\s*` +
            `([a-zA-Z0-9$_]+)\\s*:\\s*function[^}]+\\}\\s*,\\s*` +
            `([a-zA-Z0-9$_]+)\\s*:\\s*function[^}]+\\}\\s*,\\s*` +
            `([a-zA-Z0-9$_]+)\\s*:\\s*function[^}]+\\}`,
            'g'
          );
          let flexMatch;
          while ((flexMatch = flexRegex.exec(js)) !== null) {
            const objBody = flexMatch[0];
            if (objBody.includes(`c[${spliceIdx}]`) && objBody.includes(`c[${reverseIdx}]`) && objBody.includes(`c[${lengthIdx}]`)) {
              helperMatch = flexMatch;
              break;
            }
          }
        }

        if (!helperMatch) throw new Error('Helper object (Nx-style) not found');

        const helperObjName = helperMatch[1];
        // Map each method name to its operation by inspecting which c[] index it uses
        const helperBody = helperMatch[0];
        const helperMethodNames = [helperMatch[2], helperMatch[3], helperMatch[4]];
        const helperOps = {};

        for (const methodName of helperMethodNames) {
          // Extract this method's body from the helper
          const methodBodyRegex = new RegExp(
            `${methodName}\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{([^}]+)\\}`
          );
          const bodyMatch = helperBody.match(methodBodyRegex);
          if (!bodyMatch) continue;
          const body = bodyMatch[1];

          if (body.includes(`c[${reverseIdx}]`)) {
            helperOps[methodName] = 'reverse';
          } else if (body.includes(`c[${spliceIdx}]`)) {
            helperOps[methodName] = 'splice';
          } else if (body.includes(`c[${lengthIdx}]`)) {
            helperOps[methodName] = 'swap';
          }
        }
        console.log(`[YouTubeDownloader] Helper '${helperObjName}' ops:`, JSON.stringify(helperOps));

        // Build reverse map: c-array value -> operation
        const cValueToOp = {};
        for (const [name, op] of Object.entries(helperOps)) {
          cValueToOp[name] = op;
        }

        // 3. Find the entry function that sets "alr" and calls the decipher with
        //    XOR constants.  Pattern:
        //    Ta=function(R,K="",x=""){R=new g.N0(R,!0);R.set("alr","yes");
        //        x&&(x=iv(21,595,Rg(30,1091,x)),R[c[22]](K,K2(43,6163,x)));return R}
        //    We need: the decipher function name (iv) and its two constant args.
        const entryMatch = js.match(
          /([a-zA-Z0-9$_]+)\s*=\s*function\s*\([^)]*\)\s*\{[^}]*\.set\(\s*"alr"\s*,\s*"yes"\s*\)[^}]*?([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*[a-zA-Z0-9$_]+\s*\(\s*\d+\s*,\s*\d+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\)[^}]*\}/
        );
        if (!entryMatch) throw new Error('Entry function (Ta-style with "alr") not found');

        const entryFuncName = entryMatch[1];
        const decipherFuncName = entryMatch[2];
        const rConst = parseInt(entryMatch[3]);
        const kConst = parseInt(entryMatch[4]);
        const S = kConst ^ rConst;
        console.log(`[YouTubeDownloader] Entry '${entryFuncName}': decipher='${decipherFuncName}', R=${rConst}, K=${kConst}, S=${S}`);

        // 4. Find the decipher function (iv) and extract operations.
        //    The function body contains a block with:
        //      var t = x[c[S^A]](c[S^B])     // split("")
        //      Helper[c[S^C]](t, arg)         // operation calls
        //      ...
        //      p = t[c[S^D]](c[S^E])          // join("")
        const decipherDefRegex = new RegExp(`\\b${decipherFuncName}\\s*=\\s*function\\s*\\(`);
        const decipherDefMatch = js.match(decipherDefRegex);
        if (!decipherDefMatch) throw new Error(`Decipher function '${decipherFuncName}' definition not found`);

        // Extract function body (up to 5000 chars should be plenty)
        const decipherBody = js.substring(decipherDefMatch.index, decipherDefMatch.index + 5000);

        // Find all Helper[c[S^N]](t, arg) calls in the decipher body
        const helperEscaped = helperObjName.replace(/[$]/g, '\\$');
        const callRegex = new RegExp(
          `${helperEscaped}\\[c\\[S\\^(\\d+)\\]\\]\\(\\s*[a-zA-Z0-9$_]+\\s*(?:,\\s*(?:(\\d+)|S\\^(\\d+)))?\\s*\\)`,
          'g'
        );

        let callMatch;
        const instructions = [];
        while ((callMatch = callRegex.exec(decipherBody)) !== null) {
          const methodXor = parseInt(callMatch[1]);
          const methodCIdx = S ^ methodXor;
          const methodName = cArray[methodCIdx];
          const op = cValueToOp[methodName];

          let argVal = 0;
          if (callMatch[2]) {
            argVal = parseInt(callMatch[2]);
          } else if (callMatch[3]) {
            argVal = S ^ parseInt(callMatch[3]);
          }

          if (op) {
            instructions.push({ op, arg: argVal });
          } else {
            console.warn(`[YouTubeDownloader] Unknown helper method '${methodName}' at c[${methodCIdx}]`);
          }
        }

        if (instructions.length > 0) {
          console.log(`[YouTubeDownloader] Pipeline C: extracted ${instructions.length} decipher operations!`);
          for (const inst of instructions) {
            console.log(`[YouTubeDownloader]   ${inst.op}(${inst.arg})`);
          }

          const decipher = (sig) => {
            let arr = sig.split('');
            for (const inst of instructions) {
              if (inst.op === 'reverse') {
                arr.reverse();
              } else if (inst.op === 'splice') {
                arr.splice(0, inst.arg);
              } else if (inst.op === 'swap') {
                const idx = inst.arg % arr.length;
                const tmp = arr[0];
                arr[0] = arr[idx];
                arr[idx] = tmp;
              }
            }
            return arr.join('');
          };

          this._decipherCache = { jsUrl, decipher };
          return decipher;
        }
        throw new Error('No decipher operations extracted from Pipeline C');
      } catch (err) {
        console.warn('[YouTubeDownloader] Pipeline C failed:', err.message);
      }

      // ─── Pipeline B (fallback): Classic dot-notation split/join decipher ───
      // Pattern: funcName=function(a){a=a.split("");helper.method(a,N);...;return a.join("")}
      const funcMatch =
        js.match(/([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\(\s*(?:""|'')\s*\);\s*([^\}]+)\s*return\s+\2\.join\(\s*(?:""|'')\s*\)\s*\}/)
        || js.match(/function\s+([a-zA-Z0-9$_]+)\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\(\s*(?:""|'')\s*\);\s*([^\}]+)\s*return\s+\2\.join\(\s*(?:""|'')\s*\)\s*\}/)
        || js.match(/([a-zA-Z0-9$_]+)\s*=\s*\(([a-zA-Z0-9$_]+)\)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*(?:""|'')\s*\);\s*([^\}]+)\s*return\s+\2\.join\(\s*(?:""|'')\s*\)\s*\}/);

      if (!funcMatch) {
        throw new Error('No decipher function pattern found (Pipeline B)');
      }

      const funcBody = funcMatch[3];

      // Parse instruction sequences: helper.method(a, N)
      const stmtRegex = /([a-zA-Z0-9$_]+)\.([a-zA-Z0-9$_]+)\(\s*[a-zA-Z0-9$_]+\s*,\s*(\d+)\s*\)/g;
      let stmtMatch;
      const instructions = [];
      let helperName = null;

      while ((stmtMatch = stmtRegex.exec(funcBody)) !== null) {
        helperName = stmtMatch[1];
        instructions.push({
          methodName: stmtMatch[2],
          param: parseInt(stmtMatch[3])
        });
      }

      if (!helperName || instructions.length === 0) {
        throw new Error('Could not parse decipher instructions (Pipeline B)');
      }

      // Extract the helper object definition
      const helperEscaped = helperName.replace(/[$]/g, '\\$');
      const helperStartRegex = new RegExp(`(?:var\\s+|const\\s+|let\\s+|\\b)${helperEscaped}\\s*=\\s*\\{`);
      const startMatch = js.match(helperStartRegex);
      if (!startMatch) {
        throw new Error(`Helper object ${helperName} start not found`);
      }

      const startIdx = startMatch.index + startMatch[0].length - 1;
      let braceCount = 1;
      let endIdx = startIdx + 1;
      while (braceCount > 0 && endIdx < js.length) {
        const char = js[endIdx];
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        endIdx++;
      }

      if (braceCount > 0) {
        throw new Error(`Unmatched braces for helper object ${helperName}`);
      }

      const helperBody = js.substring(startIdx + 1, endIdx - 1);

      // Map helper methods to operations
      const methodRegex = /([a-zA-Z0-9$_]+)\s*(?::\s*function\s*\([^)]*\)|:\s*\([^)]*\)\s*=>|\([^)]*\))\s*\{([^}]+)\}/g;
      let methodMatch;
      const methodsMap = Object.create(null);

      while ((methodMatch = methodRegex.exec(helperBody)) !== null) {
        const name = methodMatch[1];
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
        const body = methodMatch[2];

        if (body.includes('.reverse')) {
          methodsMap[name] = 'reverse';
        } else if (body.includes('.splice') || body.includes('.slice')) {
          methodsMap[name] = 'slice';
        } else {
          methodsMap[name] = 'swap';
        }
      }

      const decipher = (sig) => {
        let arr = sig.split('');
        for (const inst of instructions) {
          const op = methodsMap[inst.methodName];
          const val = inst.param;
          if (!op) continue;

          if (op === 'reverse') {
            arr.reverse();
          } else if (op === 'slice') {
            arr.splice(0, val);
          } else if (op === 'swap') {
            const tmp = arr[0];
            arr[0] = arr[val % arr.length];
            arr[val % arr.length] = tmp;
          }
        }
        return arr.join('');
      };

      this._decipherCache = { jsUrl, decipher };
      console.log('[YouTubeDownloader] Decipher extracted via Pipeline B (classic)!');
      return decipher;
    } catch (e) {
      console.error('[YouTubeDownloader] Signature extraction failed:', e.message);
      return null;
    }
  }

  /**
   * Get direct download URL for a YouTube video.
   * @param {string} videoUrl - YouTube watch URL
   * @param {string} quality - Desired height (e.g. '1080', '720')
   * @returns {Promise<{url: string, filename: string, audioUrl?: string, isCombined: boolean}|null>}
   */
  static async getDownloadUrl(videoUrl, quality = '1080') {
    const videoId = this._extractVideoId(videoUrl);
    if (!videoId) return null;

    // ─── Pipeline 0: Innertube API (most reliable for direct URLs) ───
    try {
      console.log(`[YouTubeDownloader] Innertube pipeline starting for ID: ${videoId}`);
      const innertube = await this.getInnertubeStreams(videoId);
      if (innertube && innertube.playerResponse) {
        const streamingData = innertube.playerResponse.streamingData;
        const videoDetails = innertube.playerResponse.videoDetails;
        const adaptiveFormats = streamingData.adaptiveFormats || [];
        const formats = streamingData.formats || [];

        // For innertube, try direct URLs first (no decipher needed)
        const videoStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('video/') && f.url && (f.mimeType?.includes('mp4') || f.mimeType?.includes('webm')))
          .sort((a, b) => {
            const ha = a.height || 0;
            const hb = b.height || 0;
            if (ha !== hb) return hb - ha;
            return (b.bitrate || 0) - (a.bitrate || 0);
          });

        const audioStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('audio/') && f.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        const targetHeight = parseInt(quality) || 1080;
        let bestVideo = videoStreams.find(f => (f.height || 0) <= targetHeight) || videoStreams[0];

        // Also check combined formats (formats[] has audio+video muxed)
        if (!bestVideo) {
          const combinedStream = formats
            .filter(f => f.url && f.mimeType?.startsWith('video/'))
            .sort((a, b) => (b.height || 0) - (a.height || 0))
            .find(f => (f.height || 0) <= targetHeight) || formats.filter(f => f.url)[0];
          if (combinedStream) {
            const title = videoDetails?.title || 'YouTube Video';
            const author = videoDetails?.author || '';
            console.log(`[YouTubeDownloader] Innertube resolved combined stream: ${combinedStream.qualityLabel || combinedStream.height + 'p'}`);
            return {
              url: combinedStream.url,
              filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
              quality: combinedStream.qualityLabel || `${combinedStream.height}p`,
              isCombined: true,
            };
          }
        }

        if (bestVideo) {
          const title = videoDetails?.title || 'YouTube Video';
          const author = videoDetails?.author || '';
          const isWebmVideo = bestVideo.mimeType?.includes('webm');
          const matchedAudio = audioStreams.find(a => isWebmVideo ? a.mimeType?.includes('webm') : a.mimeType?.includes('mp4'))
            || audioStreams[0];
          const ext = isWebmVideo ? '.webm' : '.mp4';
          console.log(`[YouTubeDownloader] Innertube resolved adaptive stream: ${bestVideo.qualityLabel || bestVideo.height + 'p'} via ${innertube.clientName}`);
          return {
            url: bestVideo.url,
            audioUrl: matchedAudio?.url || null,
            filename: author ? `${author} - ${title}${ext}` : `${title}${ext}`,
            quality: bestVideo.qualityLabel || `${bestVideo.height}p`,
            isCombined: false,
          };
        }
      }
    } catch (e) {
      console.warn('[YouTubeDownloader] Innertube pipeline failed:', e.message);
    }

    // ─── Pipeline 1: Native Direct Scrape + Signature Deciphering ───
    try {
      console.log(`[YouTubeDownloader] Decipher pipeline starting for ID: ${videoId}`);
      const direct = await this.getDirectStreams(videoId);

      if (direct && direct.playerResponse) {
        const streamingData = direct.playerResponse.streamingData;
        const videoDetails = direct.playerResponse.videoDetails;

        const adaptiveFormats = streamingData.adaptiveFormats || [];
        const formats = streamingData.formats || [];

        const hasCipher = adaptiveFormats.some(f => f.signatureCipher || f.cipher)
          || formats.some(f => f.signatureCipher || f.cipher);

        let decipher = null;
        if (hasCipher && direct.jsUrl) {
          decipher = await this.getDecipherFunction(direct.jsUrl);
        }

        const resolveStreamUrl = (fmt) => {
          if (fmt.url) return fmt.url;
          const cipherStr = fmt.signatureCipher || fmt.cipher;
          if (!cipherStr) return null;

          const parsed = parseCipher(cipherStr);
          if (!parsed.url) return null;

          if (parsed.s) {
            if (decipher) {
              try {
                const signature = decipher(parsed.s);
                const urlObj = new URL(parsed.url);
                urlObj.searchParams.set(parsed.sp, signature);
                urlObj.searchParams.set('ratebypass', 'yes'); // prevent YouTube playback throttle
                return urlObj.href;
              } catch (err) {
                console.warn('[YouTubeDownloader] Decipher evaluation crashed:', err.message);
                return null; // Return null so we fall back
              }
            }
            return null; // Return null if decipher is missing so we fall back
          }
          return parsed.url;
        };

        const videoStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('video/') && (f.mimeType?.includes('mp4') || f.mimeType?.includes('webm')))
          .map(f => {
             try { return { ...f, resolvedUrl: resolveStreamUrl(f) }; }
             catch(e) { return { ...f, resolvedUrl: null }; }
          })
          .filter(f => f.resolvedUrl)
          .sort((a, b) => {
            const ha = a.height || 0;
            const hb = b.height || 0;
            if (ha !== hb) return hb - ha;
            return (b.bitrate || 0) - (a.bitrate || 0);
          });

        // Extract Audio Streams  
        const audioStreams = adaptiveFormats
          .filter(f => f.mimeType?.startsWith('audio/') && f.mimeType?.includes('mp4'))
          .map(f => {
             try { return { ...f, resolvedUrl: resolveStreamUrl(f) }; }
             catch(e) { return { ...f, resolvedUrl: null }; }
          })
          .filter(f => f.resolvedUrl)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        const targetHeight = parseInt(quality) || 1080;
        let bestVideo = videoStreams.find(f => (f.height || 0) <= targetHeight) || videoStreams[0];

        if (bestVideo) {
          const isWebmVideo = bestVideo.mimeType?.includes('webm');
          const ext = isWebmVideo ? '.webm' : '.mp4';
          const title = videoDetails.title || 'YouTube Video';
          const author = videoDetails.author || '';
          const filename = author ? `${author} - ${title}${ext}` : `${title}${ext}`;

          // Match the audio stream format container (webm vs mp4) to the video container!
          const matchedAudio = audioStreams.find(a => isWebmVideo ? a.mimeType?.includes('webm') : a.mimeType?.includes('mp4'))
            || audioStreams[0];

          console.log(`[YouTubeDownloader] Successfully resolved direct deciphered stream: ${bestVideo.qualityLabel || bestVideo.height + 'p'}`);
          return {
            url: bestVideo.resolvedUrl,
            audioUrl: matchedAudio?.resolvedUrl || null,
            filename: filename,
            quality: bestVideo.qualityLabel || `${bestVideo.height}p`,
            isCombined: false
          };
        }
      }
    } catch (e) {
      console.warn('[YouTubeDownloader] Native deciphering pipeline failed, falling back:', e.message);
    }

    // ─── Pipeline 2: Fallback Invidious API with Local proxying ───
    const dynamicInstances = await this.fetchActiveInstances();
    const instancesToTry = [...new Set([...dynamicInstances, ...this.INVIDIOUS_INSTANCES])];
    console.log(`[MediaSniff] Attempting stream resolution via ${instancesToTry.length} Invidious instances`);

    for (const instance of instancesToTry) {
      try {
        console.log(`[MediaSniff] Querying Invidious instance: ${instance}`);
        const result = await this._tryInvidious(instance, videoId, parseInt(quality));
        if (result) {
          console.log(`[MediaSniff] Successfully resolved stream from: ${instance}`);
          return result;
        }
      } catch (e) {
        console.warn(`[MediaSniff] Invidious ${instance} failed:`, e.message);
      }
    }

    // ─── Pipeline 3: Fallback Piped API ───
    for (const instance of this.PIPED_INSTANCES) {
      try {
        console.log(`[MediaSniff] Querying Piped instance: ${instance}`);
        const result = await this._tryPiped(instance, videoId, parseInt(quality));
        if (result) {
          console.log(`[MediaSniff] Successfully resolved stream from Piped: ${instance}`);
          return result;
        }
      } catch (e) {
        console.warn(`[MediaSniff] Piped ${instance} failed:`, e.message);
      }
    }

    // ─── Pipeline 4: Cobalt.tools API (final fallback) ───
    try {
      console.log(`[YouTubeDownloader] Trying Cobalt API as final fallback`);
      const cobaltResult = await this.getCobaltUrl(videoUrl, quality);
      if (cobaltResult) {
        console.log(`[YouTubeDownloader] Cobalt resolved successfully`);
        return cobaltResult;
      }
    } catch (e) {
      console.warn('[YouTubeDownloader] Cobalt pipeline failed:', e.message);
    }

    return null;
  }

  static _extractVideoId(url) {
    try {
      const u = new URL(url);
      if (u.pathname.startsWith('/shorts/')) {
        return u.pathname.split('/shorts/')[1]?.split(/[?#/]/)[0] || null;
      }
      if (u.pathname.startsWith('/embed/')) {
        return u.pathname.split('/embed/')[1]?.split(/[?#/]/)[0] || null;
      }
      if (u.pathname.startsWith('/live/')) {
        return u.pathname.split('/live/')[1]?.split(/[?#/]/)[0] || null;
      }
      if (u.hostname.includes('youtube.com')) {
        return u.searchParams.get('v');
      }
      if (u.hostname === 'youtu.be') {
        return u.pathname.slice(1);
      }
    } catch { }
    const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  static async _tryInvidious(instance, videoId, targetHeight) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(`${instance}/api/v1/videos/${videoId}?local=true`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const adaptiveFormats = data.adaptiveFormats || [];
      const videoStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('video/') && f.url && (f.type?.includes('mp4') || f.type?.includes('webm')))
        .sort((a, b) => (b.resolution ? parseInt(b.resolution) : 0) - (a.resolution ? parseInt(a.resolution) : 0));
      const audioStreams = adaptiveFormats
        .filter(f => f.type?.startsWith('audio/') && f.url && (f.type?.includes('mp4') || f.type?.includes('webm')))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      let videoStream = videoStreams.find(f => {
        const h = parseInt(f.resolution) || f.qualityLabel?.match(/(\d+)p/)?.[1];
        return h && h <= targetHeight;
      }) || videoStreams[0];

      const formatStreams = data.formatStreams || [];
      const combinedStream = formatStreams
        .filter(f => f.url)
        .sort((a, b) => {
          const ha = parseInt(a.resolution) || 0;
          const hb = parseInt(b.resolution) || 0;
          return hb - ha;
        })
        .find(f => {
          const h = parseInt(f.resolution) || 0;
          return h <= targetHeight;
        }) || formatStreams[0];

      const resolveUrl = (urlStr) => {
        if (!urlStr) return null;
        if (urlStr.startsWith('/')) {
          return `${instance}${urlStr}`;
        }
        return urlStr;
      };

      // Prefer high-quality adaptive stream if targetHeight is >= 720 and we have a video and audio stream
      if (targetHeight >= 720 && videoStream?.url && audioStreams[0]?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: resolveUrl(videoStream.url),
          audioUrl: resolveUrl(audioStreams[0].url),
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: videoStream.qualityLabel || videoStream.resolution || 'Unknown',
          isCombined: false,
        };
      }

      if (combinedStream?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: resolveUrl(combinedStream.url),
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: combinedStream.qualityLabel || combinedStream.resolution || 'Unknown',
          isCombined: true,
        };
      }

      if (videoStream?.url) {
        const title = data.title || 'YouTube Video';
        const author = data.author || '';
        return {
          url: resolveUrl(videoStream.url),
          audioUrl: resolveUrl(audioStreams[0]?.url) || null,
          filename: author ? `${author} - ${title}.mp4` : `${title}.mp4`,
          quality: videoStream.qualityLabel || videoStream.resolution || 'Unknown',
          isCombined: false,
        };
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  static async _tryPiped(instance, videoId, targetHeight) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(`${instance}/streams/${videoId}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const videoStreams = (data.videoStreams || [])
        .filter(s => s.url && s.videoOnly === false)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      let stream = videoStreams.find(s => (s.height || 0) <= targetHeight) || videoStreams[0];
      if (stream?.url) {
        const title = data.title || 'YouTube Video';
        const uploader = data.uploader || '';
        return {
          url: stream.url,
          filename: uploader ? `${uploader} - ${title}.mp4` : `${title}.mp4`,
          quality: `${stream.height}p`,
          isCombined: true,
        };
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Download video with progress tracking.
   */
  static async downloadStream(downloadUrl, onProgress, signal) {
    const fetchOptions = { signal };
    // Add headers that YouTube's CDN may require
    try {
      const urlObj = new URL(downloadUrl);
      if (urlObj.hostname.includes('googlevideo.com') || urlObj.hostname.includes('youtube.com')) {
        fetchOptions.headers = {
          'Origin': 'https://www.youtube.com',
          'Referer': 'https://www.youtube.com/',
        };
      }
    } catch (e) { /* ignore URL parse errors */ }
    const response = await fetch(downloadUrl, fetchOptions);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const contentLength = parseInt(response.headers.get('content-length')) || 0;
    const contentType = response.headers.get('content-type') || '';
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    const startTime = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? received / elapsed : 0;
        const percent = contentLength > 0 ? Math.round((received / contentLength) * 100) : 0;
        onProgress({
          percent: Math.min(percent, 100),
          received,
          total: contentLength,
          speed,
          speedLabel: speed > 0 ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s` : '',
          sizeLabel: `${(received / (1024 * 1024)).toFixed(1)} MB`,
        });
      }
    }
    return new Blob(chunks, { type: contentType });
  }
}
