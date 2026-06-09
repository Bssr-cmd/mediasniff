import re

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()

# The c array might be built from a string split, similar to the old R array pattern
# Look for any split that creates a large array assigned to a single-letter variable

print("=== Large array-producing splits ===")
for m in re.finditer(r'([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*["\']([^"\']{100,})["\']\.split\(\s*["\']([^"\']*)["\']', js):
    name = m.group(1)
    content = m.group(2)
    sep = m.group(3)
    arr = content.split(sep)
    print(f"  {name} = '...'.split('{sep}') -> {len(arr)} items")
    if len(arr) > 20:
        # Check for key strings
        for target in ['ue', 'bi', 'jR', 'splice', 'reverse', 'length', 'split', 'join', 'set', 'toString']:
            if target in arr:
                print(f"    '{target}' at index {arr.index(target)}")
        # Print first 50 items
        print(f"    First 50: {arr[:50]}")

# Also look for computed c array via function
print("\n=== c variable definitions ===")
for m in re.finditer(r'(?:^|[;,{}\s])\s*c\s*=\s*', js):
    context = js[m.start():m.start()+200]
    print(f"At index {m.start()}: {context[:200]}")

# Search for the pattern: c=something that's an array
# Try to find where c is referenced as c[22], c[7], etc.
# Search for the first occurrence of c[7] near code that uses "length"
print("\n=== Searching for c[7] near 'length' ===")
for m in re.finditer(r'c\[7\]', js):
    context = js[max(0,m.start()-50):m.end()+50]
    if 'length' in context or 'R[c[7]]' in context or '.length' in context:
        print(f"At {m.start()}: ...{context}...")
        break

# Let's check the Nx helper more carefully for clues about what c[7], c[26], c[46] are
print("\n=== Nx helper - what methods does it use? ===")
nx_match = re.search(r'Nx\s*=\s*\{', js)
if nx_match:
    depth = 1
    pos = nx_match.end()
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    nx_body = js[nx_match.start():pos]
    print(f"Full Nx: {nx_body}")
    
    # Extract all c[N] references in Nx
    for cm in re.finditer(r'c\[(\d+)\]', nx_body):
        idx = int(cm.group(1))
        print(f"  Nx uses c[{idx}]")

# Now let's look for what makes c. It might be a global defined before Nx
# Search the first 5000 chars
print("\n=== First 3000 chars of file ===")
print(js[:3000])
