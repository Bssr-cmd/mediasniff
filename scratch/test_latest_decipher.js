const https = require('https');

function getUrlContent(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function test() {
  console.log("1. Fetching YouTube watch page...");
  let html;
  try {
    html = await getUrlContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  } catch (err) {
    console.error("Failed to fetch watch page:", err.message);
    process.exit(1);
  }

  console.log("2. Finding player base.js URL...");
  const jsUrlMatch = html.match(/"jsUrl"\s*:\s*"([^"]+)"/) 
    || html.match(/href="([^"]+base\.js)"/)
    || html.match(/\/s\/player\/[a-zA-Z0-9_-]+\/player_ias\.vflset\/[a-zA-Z0-9_/-]+\/base\.js/);

  if (!jsUrlMatch) {
    console.error("Failed to find base.js URL");
    process.exit(1);
  }

  let jsUrl = jsUrlMatch[1] || jsUrlMatch[0];
  if (jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
  else if (jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;

  console.log("Fetching player script:", jsUrl);
  let js;
  try {
    js = await getUrlContent(jsUrl);
  } catch (err) {
    console.error("Failed to fetch player script:", err.message);
    process.exit(1);
  }

  console.log("3. Running Pipeline A extraction logic...");
  try {
    // 1. Extract R array
    const rMatch = js.match(/\bvar\s+([a-zA-Z0-9$_]+)\s*=\s*'([^']+)'\.split\(\s*(?:"|')\s*(;|\{)\s*(?:"|')\s*\)/);
    if (!rMatch) {
      throw new Error("R array match not found");
    }
    const rArrayName = rMatch[1];
    const rArray = rMatch[2].split(rMatch[3]);
    
    const spliceIdx = rArray.indexOf('splice');
    const lengthIdx = rArray.indexOf('length');
    const reverseIdx = rArray.indexOf('reverse');
    
    if (spliceIdx === -1 || lengthIdx === -1 || reverseIdx === -1) {
      throw new Error(`splice/length/reverse index not found: splice=${spliceIdx}, length=${lengthIdx}, reverse=${reverseIdx}`);
    }

    // 2. Find el definition and extract Tl, Oe, P_, B, l
    const patternEl = /el\s*=\s*function\s*\(\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*\)\s*\{[^}]*?\.set\(\s*["']alr["']\s*,\s*["']yes["']\s*\)\s*;\s*\3\s*&&\s*\(\s*\3\s*=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*,\s*\1\[.*?\]\(\s*\2\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*\)/;
    const elMatch = js.match(patternEl);
    if (!elMatch) {
      throw new Error("el definition match not found");
    }

    const tlName = elMatch[4];
    const oeName = elMatch[7];
    const pName = elMatch[8];
    const bVal = parseInt(elMatch[5]);
    const lVal = parseInt(elMatch[6]);
    const wVal = lVal ^ bVal;
    
    console.log(`Found el: tlName=${tlName}, oeName=${oeName}, bVal=${bVal}, lVal=${lVal}, W=${wVal}`);

    // 3. Find helper object and map methods to splice, swap, reverse
    const patternHelper = new RegExp(`var\\s+([a-zA-Z0-9$_]+)\\s*=\\s*\\{\\s*([a-zA-Z0-9$_]+)\\s*:\\s*function\\s*\\(\\s*[a-zA-Z0-9$_]+\\s*,\\s*[a-zA-Z0-9$_]+\\s*\\)\\s*\\{\\s*[a-zA-Z0-9$_]+\\s*\\[\\s*${rArrayName}\\s*\\[\\s*${spliceIdx}\\s*\\]\\s*\\]\\s*\\(\\s*0\\s*,\\s*[a-zA-Z0-9$_]+\\s*\\)\\s*\\}\\s*,\\s*([a-zA-Z0-9$_]+)\\s*:\\s*function\\s*\\(\\s*[a-zA-Z0-9$_]+\\s*,\\s*[a-zA-Z0-9$_]+\\s*\\)\\s*\\{.*?\\}\\s*,\\s*([a-zA-Z0-9$_]+)\\s*:\\s*function\\s*\\(\\s*[a-zA-Z0-9$_]+\\s\\)\\s*\\{.*?\\}\\s*\\}`);
    const helperMatch = js.match(patternHelper);
    if (!helperMatch) {
      throw new Error("helper object match not found");
    }

    const helperName = helperMatch[1];
    const helperMethods = {
      [helperMatch[2]]: 'splice',
      [helperMatch[3]]: 'swap',
      [helperMatch[4]]: 'reverse'
    };
    console.log(`Found helper ${helperName}:`, helperMethods);

    // 4. Find the deciphering block in Tl definition
    const tlDefRegex = new RegExp(`\\b${tlName}\\s*=\\s*function\\b`);
    const tlDefMatch = js.match(tlDefRegex);
    if (!tlDefMatch) {
      throw new Error(`Failed to find ${tlName} definition`);
    }

    const tlBody = js.substring(tlDefMatch.index, tlDefMatch.index + 10000);
    const decipherBlockMatch = tlBody.match(/if\s*\(\s*!\s*\(\s*\(\s*B\s*\^\s*51\s*\)\s*>>\s*3\s*\)\s*\)\s*\{([^}]+)\}/);
    if (!decipherBlockMatch) {
      throw new Error('Failed to find decipher block inside Tl');
    }

    const blockContent = decipherBlockMatch[1];
    const callRegex = new RegExp(`${helperName}\\[\\s*${rArrayName}\\s*\\[\\s*W\\s*\\^\\s*(\\d+)\\s*\\]\\s*\\]\\(\\s*P\\s*(?:,\\s*([^)]+))?\\s*\\)`, 'g');
    
    let matchCall;
    const instructions = [];
    while ((matchCall = callRegex.exec(blockContent)) !== null) {
      const methodXor = parseInt(matchCall[1]);
      const methodIdx = wVal ^ methodXor;
      const methodName = rArray[methodIdx];
      const opType = helperMethods[methodName];
      
      let argVal = 0;
      if (matchCall[2]) {
        const argStr = matchCall[2].trim();
        if (/^\d+$/.test(argStr)) {
          argVal = parseInt(argStr);
        } else {
          const argXorMatch = argStr.match(/W\s*\^\s*(\d+)/);
          if (argXorMatch) {
            argVal = wVal ^ parseInt(argXorMatch[1]);
          }
        }
      }
      instructions.push({ op: opType, arg: argVal });
    }

    if (instructions.length === 0) {
      throw new Error("No operations parsed");
    }

    console.log(`Parsed ${instructions.length} operations successfully!`);
    
    const decipher = (sig) => {
      let arr = sig.split('');
      for (const inst of instructions) {
        const op = inst.op;
        const val = inst.arg;
        if (op === 'reverse') {
          arr.reverse();
        } else if (op === 'splice') {
          arr.splice(0, val);
        } else if (op === 'swap') {
          const tmp = arr[0];
          arr[0] = arr[val % arr.length];
          arr[val % arr.length] = tmp;
        }
      }
      return arr.join('');
    };

    const testSig = "a1b2c3d4e5f6g7h8i9j0";
    const result = decipher(testSig);
    console.log(`TEST SUCCESS: "${testSig}" deciphered to "${result}"`);
    process.exit(0);

  } catch (err) {
    console.error("TEST FAILED:", err.message);
    process.exit(1);
  }
}

test();
