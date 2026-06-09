/**
 * Test the new Pipeline C decipher extraction against the current YouTube base.js
 * 
 * This simulates what youtube-downloader.js does, but in Node.js for testing.
 */
const fs = require('fs');

const js = fs.readFileSync('scratch/base_new.js', 'utf-8');
console.log(`Loaded base.js: ${js.length} bytes`);

// ─── Pipeline C: c-array + Nx-style helper + iv/Ta XOR decipher ───
console.log('\n=== Pipeline C ===');

// 1. Extract c array
const cArrayMatch = js.match(/(?:var\s+)?c\s*=\s*"([^"]{100,})"/)
  || js.match(/(?:var\s+)?c\s*=\s*'([^']{100,})'/);
if (!cArrayMatch) { console.error('FAIL: c-array not found'); process.exit(1); }

const cContext = js.substring(cArrayMatch.index, cArrayMatch.index + cArrayMatch[0].length + 30);
const sepMatch = cContext.match(/\.split\(\s*"([^"]*)"/);
const sep = sepMatch ? sepMatch[1] : '{';
const cArray = cArrayMatch[1].split(sep);
console.log(`✓ c-array: ${cArray.length} elements, sep='${sep}'`);

// 2. Key indices
const spliceIdx = cArray.indexOf('splice');
const reverseIdx = cArray.indexOf('reverse');
const lengthIdx = cArray.indexOf('length');
console.log(`✓ splice=${spliceIdx}, reverse=${reverseIdx}, length=${lengthIdx}`);

if (spliceIdx === -1 || reverseIdx === -1 || lengthIdx === -1) {
  console.error('FAIL: Missing required method names');
  process.exit(1);
}

// 3. Find helper object
const flexRegex = new RegExp(
  `([a-zA-Z0-9$_]+)\\s*=\\s*\\{\\s*` +
  `([a-zA-Z0-9$_]+)\\s*:\\s*function[^}]+\\}\\s*,\\s*` +
  `([a-zA-Z0-9$_]+)\\s*:\\s*function[^}]+\\}\\s*,\\s*` +
  `([a-zA-Z0-9$_]+)\\s*:\\s*function[^}]+\\}`,
  'g'
);
let helperMatch = null;
let flexMatch;
while ((flexMatch = flexRegex.exec(js)) !== null) {
  const objBody = flexMatch[0];
  if (objBody.includes(`c[${spliceIdx}]`) && objBody.includes(`c[${reverseIdx}]`) && objBody.includes(`c[${lengthIdx}]`)) {
    helperMatch = flexMatch;
    break;
  }
}

if (!helperMatch) { console.error('FAIL: Helper object not found'); process.exit(1); }

const helperObjName = helperMatch[1];
const helperBody = helperMatch[0];
const helperMethodNames = [helperMatch[2], helperMatch[3], helperMatch[4]];
const helperOps = {};

for (const methodName of helperMethodNames) {
  const methodBodyRegex = new RegExp(`${methodName}\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{([^}]+)\\}`);
  const bodyMatch = helperBody.match(methodBodyRegex);
  if (!bodyMatch) continue;
  const body = bodyMatch[1];
  if (body.includes(`c[${reverseIdx}]`)) helperOps[methodName] = 'reverse';
  else if (body.includes(`c[${spliceIdx}]`)) helperOps[methodName] = 'splice';
  else if (body.includes(`c[${lengthIdx}]`)) helperOps[methodName] = 'swap';
}

console.log(`✓ Helper '${helperObjName}' ops:`, JSON.stringify(helperOps));

const cValueToOp = {};
for (const [name, op] of Object.entries(helperOps)) {
  cValueToOp[name] = op;
}

// 4. Find entry function (Ta-style)
const entryMatch = js.match(
  /([a-zA-Z0-9$_]+)\s*=\s*function\s*\([^)]*\)\s*\{[^}]*\.set\(\s*"alr"\s*,\s*"yes"\s*\)[^}]*?([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*[a-zA-Z0-9$_]+\s*\(\s*\d+\s*,\s*\d+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\)[^}]*\}/
);
if (!entryMatch) { console.error('FAIL: Entry function not found'); process.exit(1); }

const decipherFuncName = entryMatch[2];
const rConst = parseInt(entryMatch[3]);
const kConst = parseInt(entryMatch[4]);
const S = kConst ^ rConst;
console.log(`✓ Entry '${entryMatch[1]}': decipher='${decipherFuncName}', R=${rConst}, K=${kConst}, S=${S}`);

// 5. Find decipher function and extract operations
const decipherDefRegex = new RegExp(`\\b${decipherFuncName}\\s*=\\s*function\\s*\\(`);
const decipherDefMatch = js.match(decipherDefRegex);
if (!decipherDefMatch) { console.error('FAIL: Decipher function not found'); process.exit(1); }

const decipherBody = js.substring(decipherDefMatch.index, decipherDefMatch.index + 5000);

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
  if (callMatch[2]) argVal = parseInt(callMatch[2]);
  else if (callMatch[3]) argVal = S ^ parseInt(callMatch[3]);

  if (op) {
    instructions.push({ op, arg: argVal });
  }
}

console.log(`✓ Extracted ${instructions.length} decipher operations:`);
for (const inst of instructions) {
  console.log(`    ${inst.op}(${inst.arg})`);
}

if (instructions.length === 0) {
  console.error('FAIL: No operations extracted');
  process.exit(1);
}

// 6. Test decipher
const testSig = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
let arr = testSig.split('');
for (const inst of instructions) {
  if (inst.op === 'reverse') arr.reverse();
  else if (inst.op === 'splice') arr.splice(0, inst.arg);
  else if (inst.op === 'swap') {
    const idx = inst.arg % arr.length;
    const tmp = arr[0];
    arr[0] = arr[idx];
    arr[idx] = tmp;
  }
}
const result = arr.join('');

console.log(`\n✓ Decipher test:`);
console.log(`  Input:  ${testSig}`);
console.log(`  Output: ${result}`);
console.log(`  Changed: ${testSig !== result ? 'YES' : 'NO (BUG!)'}`);

if (testSig === result) {
  console.error('\nFAIL: Decipher produced identical output — operations may be wrong');
  process.exit(1);
}

console.log('\n✅ All Pipeline C tests PASSED!');
