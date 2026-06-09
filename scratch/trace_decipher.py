import re

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()

# The key function is:
# Ta=function(R,K="",x=""){R=new g.N0(R,!0);R.set("alr","yes");x&&(x=iv(21,595,Rg(30,1091,x)),R[c[22]](K,K2(43,6163,x)));return R}
# 
# Here:
# - x is the raw signature (s parameter from signatureCipher)
# - Rg(30, 1091, x) = decipher step 1
# - iv(21, 595, <result>) = decipher step 2 (further processing)
# - K2(43, 6163, <result>) = some final transform
# - R[c[22]](K, ...) = URL.searchParams.set(sp, decipheredSig)

# 1. Find the `c` array
print("=== Looking for c array ===")
# Search for var c = [...] or c = [...]
# The c array is likely a small lookup table
for m in re.finditer(r'\bvar\s+c\s*=\s*\[([^\]]{10,500})\]', js):
    arr_str = m.group(1)
    print(f"Found c array at index {m.start()}: {arr_str[:200]}")

# Try without 'var'
for m in re.finditer(r'\bc\s*=\s*\[([^\]]{10,500})\]', js):
    if m.start() > 0 and js[m.start()-1].isalnum():
        continue
    arr_str = m.group(1)
    # Only care about string arrays
    if '"' in arr_str or "'" in arr_str:
        print(f"Found c array at index {m.start()}: {arr_str[:200]}")

# 2. Find iv function
print("\n=== Looking for iv function ===")
iv_match = re.search(r'\biv\s*=\s*function\s*\(([^)]*)\)\s*\{', js)
if iv_match:
    # Get the body
    body_start = iv_match.end()
    # Find balanced braces
    depth = 1
    pos = body_start
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    body = js[body_start:pos-1]
    print(f"iv function({iv_match.group(1)}): {body[:500]}")

# 3. Find Rg function  
print("\n=== Looking for Rg function ===")
rg_match = re.search(r'\bRg\s*=\s*function\s*\(([^)]*)\)\s*\{', js)
if rg_match:
    body_start = rg_match.end()
    depth = 1
    pos = body_start
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    body = js[body_start:pos-1]
    print(f"Rg function({rg_match.group(1)}): {body[:500]}")

# 4. Find K2 function
print("\n=== Looking for K2 function ===")
k2_match = re.search(r'\bK2\s*=\s*function\s*\(([^)]*)\)\s*\{', js)
if k2_match:
    body_start = k2_match.end()
    depth = 1
    pos = body_start
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    body = js[body_start:pos-1]
    print(f"K2 function({k2_match.group(1)}): {body[:500]}")

# 5. Find hS function (used in signature URL building: hS(R.S, K.Os))
print("\n=== Looking for hS function (signature URL builder) ===")
hs_match = re.search(r'\bhS\s*=\s*function\s*\(([^)]*)\)\s*\{', js)
if hs_match:
    body_start = hs_match.end()
    depth = 1
    pos = body_start
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    body = js[body_start:pos-1]
    print(f"hS function({hs_match.group(1)}): {body[:500]}")

# 6. Find MD function (URL builder)
print("\n=== Looking for MD function ===")
md_match = re.search(r'\bMD\s*=\s*function\s*\(([^)]*)\)\s*\{', js)
if md_match:
    body_start = md_match.end()
    depth = 1
    pos = body_start
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    body = js[body_start:pos-1]
    print(f"MD function({md_match.group(1)}): {body[:500]}")

# 7. Let's also find j8 function (used in another alr context)
print("\n=== Looking for j8 function ===")
j8_match = re.search(r'\bj8\s*=\s*function\s*\(([^)]*)\)\s*\{', js)
if j8_match:
    body_start = j8_match.end()
    depth = 1
    pos = body_start
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    body = js[body_start:pos-1]
    print(f"j8 function({j8_match.group(1)}): {body[:500]}")
