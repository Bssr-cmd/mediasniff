import re

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()

print(f"File size: {len(js)} bytes")

# Look at the 'alr' context more carefully — specifically the Ta function
# Ta=function(R,K="",x=""){R=new g.N0(R,!0);R.set("alr","yes");x&&(x=iv(21,595,Rg(30,1091,x)),R[c[22]](K,K2(43,6163,x)));return R};

# This is the URL signature function. Let's find:
# 1. The iv function (decipher)
# 2. The Rg function
# 3. The K2 function
# 4. The c array

# Search for all 'alr' contexts
print("=== All 'alr' contexts ===")
for m in re.finditer(r'"alr"', js):
    start = max(0, m.start() - 200)
    end = min(len(js), m.end() + 200)
    context = js[start:end]
    print(f"\nAt index {m.start()}:")
    print(context)
    print("---")

# Look for the Ta function specifically
print("\n=== Searching for Ta/signature URL function ===")
ta_match = re.search(r'Ta\s*=\s*function\s*\([^)]*\)\s*\{[^}]*"alr"[^}]*\}', js)
if ta_match:
    print(f"Found Ta function: {ta_match.group()}")

# More generic: find function containing "alr" set
print("\n=== Functions setting 'alr' ===")
# Find the function that does R.set("alr","yes")
alr_set_pattern = re.compile(r'([a-zA-Z0-9$_]+)\s*=\s*function\s*\(([^)]*)\)\s*\{([^}]*?\.set\(\s*"alr"\s*,\s*"yes"\s*\)[^}]*)\}')
for m in alr_set_pattern.finditer(js):
    print(f"\nFunction: {m.group(1)}({m.group(2)})")
    print(f"Body: {m.group(3)}")

# Search for any split("") pattern (classic decipher entry point)
print("\n=== split('') patterns ===")
for m in re.finditer(r'''\.split\(\s*(?:""|'')\s*\)''', js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 100)
    print(f"\nAt index {m.start()}:")
    print(js[start:end])

# Look for the c array definition
print("\n=== Looking for c array (used in R[c[22]]) ===")
c_match = re.search(r'\bvar\s+c\s*=\s*\[', js)
if c_match:
    print(f"Found c array at index {c_match.start()}")
    print(js[c_match.start():c_match.start()+300])

# Look for any variable = string.split(";") or similar array patterns with 'splice'
print("\n=== Looking for arrays containing 'splice' ===")
for m in re.finditer(r"'([^']*splice[^']*)'\.split\(", js):
    print(f"At index {m.start()}: length={len(m.group(1))}")
    arr = m.group(1).split(";")
    print(f"  Split by ';': {len(arr)} items")
    if 'splice' in arr:
        print(f"  splice at index {arr.index('splice')}")
    # Try other separators
    for sep in [";", "{", ","]:
        arr2 = m.group(1).split(sep)
        if 'splice' in arr2:
            print(f"  Split by '{sep}': {len(arr2)} items, splice at {arr2.index('splice')}")
