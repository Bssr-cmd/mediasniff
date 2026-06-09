"""
Test the new Pipeline C decipher extraction against the current YouTube base.js.
Simulates what youtube-downloader.js does, but in Python for testing.
"""
import re, sys

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()
print(f"Loaded base.js: {len(js)} bytes")

# 1. Extract c array
cArrayMatch = re.search(r'(?:var\s+)?c\s*=\s*"([^"]{100,})"', js)
if not cArrayMatch:
    cArrayMatch = re.search(r"(?:var\s+)?c\s*=\s*'([^']{100,})'", js)
if not cArrayMatch:
    print("FAIL: c-array not found"); sys.exit(1)

cContext = js[cArrayMatch.start():cArrayMatch.end()+30]
sepMatch = re.search(r'\.split\(\s*"([^"]*)"', cContext)
sep = sepMatch.group(1) if sepMatch else '{'
cArray = cArrayMatch.group(1).split(sep)
print(f"✓ c-array: {len(cArray)} elements, sep='{sep}'")

# 2. Key indices
spliceIdx = cArray.index('splice') if 'splice' in cArray else -1
reverseIdx = cArray.index('reverse') if 'reverse' in cArray else -1
lengthIdx = cArray.index('length') if 'length' in cArray else -1
print(f"✓ splice={spliceIdx}, reverse={reverseIdx}, length={lengthIdx}")
if -1 in (spliceIdx, reverseIdx, lengthIdx):
    print("FAIL: Missing method names"); sys.exit(1)

# 3. Find helper object (flexible search)
flexRegex = re.compile(
    r'([a-zA-Z0-9$_]+)\s*=\s*\{\s*'
    r'([a-zA-Z0-9$_]+)\s*:\s*function[^}]+\}\s*,\s*'
    r'([a-zA-Z0-9$_]+)\s*:\s*function[^}]+\}\s*,\s*'
    r'([a-zA-Z0-9$_]+)\s*:\s*function[^}]+\}'
)
helperMatch = None
for m in flexRegex.finditer(js):
    body = m.group(0)
    if f'c[{spliceIdx}]' in body and f'c[{reverseIdx}]' in body and f'c[{lengthIdx}]' in body:
        helperMatch = m
        break

if not helperMatch:
    print("FAIL: Helper object not found"); sys.exit(1)

helperObjName = helperMatch.group(1)
helperBody = helperMatch.group(0)
helperMethodNames = [helperMatch.group(2), helperMatch.group(3), helperMatch.group(4)]
helperOps = {}

for methodName in helperMethodNames:
    bodyMatch = re.search(rf'{methodName}\s*:\s*function\s*\([^)]*\)\s*\{{([^}}]+)\}}', helperBody)
    if not bodyMatch:
        continue
    body = bodyMatch.group(1)
    if f'c[{reverseIdx}]' in body:
        helperOps[methodName] = 'reverse'
    elif f'c[{spliceIdx}]' in body:
        helperOps[methodName] = 'splice'
    elif f'c[{lengthIdx}]' in body:
        helperOps[methodName] = 'swap'

print(f"✓ Helper '{helperObjName}' ops: {helperOps}")

cValueToOp = {name: op for name, op in helperOps.items()}

# 4. Find entry function (Ta-style)
entryMatch = re.search(
    r'([a-zA-Z0-9$_]+)\s*=\s*function\s*\([^)]*\)\s*\{[^}]*\.set\(\s*"alr"\s*,\s*"yes"\s*\)[^}]*?([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*[a-zA-Z0-9$_]+\s*\(\s*\d+\s*,\s*\d+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\)[^}]*\}',
    js
)
if not entryMatch:
    print("FAIL: Entry function not found"); sys.exit(1)

decipherFuncName = entryMatch.group(2)
rConst = int(entryMatch.group(3))
kConst = int(entryMatch.group(4))
S = kConst ^ rConst
print(f"✓ Entry '{entryMatch.group(1)}': decipher='{decipherFuncName}', R={rConst}, K={kConst}, S={S}")

# 5. Find decipher function
decipherDefMatch = re.search(rf'\b{decipherFuncName}\s*=\s*function\s*\(', js)
if not decipherDefMatch:
    print(f"FAIL: Decipher function '{decipherFuncName}' not found"); sys.exit(1)

decipherBody = js[decipherDefMatch.start():decipherDefMatch.start()+5000]

helperEscaped = helperObjName.replace('$', r'\$')
callRegex = re.compile(
    rf'{helperEscaped}\[c\[S\^(\d+)\]\]\(\s*[a-zA-Z0-9$_]+\s*(?:,\s*(?:(\d+)|S\^(\d+)))?\s*\)'
)

instructions = []
for m in callRegex.finditer(decipherBody):
    methodXor = int(m.group(1))
    methodCIdx = S ^ methodXor
    methodName = cArray[methodCIdx] if methodCIdx < len(cArray) else '?'
    op = cValueToOp.get(methodName)
    
    argVal = 0
    if m.group(2):
        argVal = int(m.group(2))
    elif m.group(3):
        argVal = S ^ int(m.group(3))
    
    if op:
        instructions.append((op, argVal))

print(f"✓ Extracted {len(instructions)} decipher operations:")
for op, arg in instructions:
    print(f"    {op}({arg})")

if not instructions:
    print("FAIL: No operations extracted"); sys.exit(1)

# 6. Test decipher
testSig = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
arr = list(testSig)
for op, arg in instructions:
    if op == 'reverse':
        arr.reverse()
    elif op == 'splice':
        arr = arr[arg:]
    elif op == 'swap':
        idx = arg % len(arr)
        arr[0], arr[idx] = arr[idx], arr[0]

result = ''.join(arr)
print(f"\n✓ Decipher test:")
print(f"  Input:  {testSig}")
print(f"  Output: {result}")
print(f"  Changed: {'YES' if testSig != result else 'NO (BUG!)'}")

if testSig == result:
    print("\nFAIL: Decipher produced identical output"); sys.exit(1)

print("\n✅ All Pipeline C tests PASSED!")
