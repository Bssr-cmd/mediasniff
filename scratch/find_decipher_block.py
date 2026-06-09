with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Let's search for a pattern like:
# var q = C.value; if (q.url) ... q.s
# We can search for \.sp or \.s near .url
print("Searching for signature decipher invocation block:")
pattern = r'\b([a-zA-Z0-9$_]+)\.s\b'
for m in re.finditer(pattern, js):
    start = max(0, m.start() - 150)
    end = min(len(js), m.end() + 150)
    if 'url' in js[start:end] and 'sp' in js[start:end]:
        print(f"Match at {m.start()}:\n{js[start:end]}\n{'-'*50}")
