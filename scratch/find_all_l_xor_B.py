with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Find any function that has W=l^B or W=B^l or similar
print("Searching for W = l ^ B or similar:")
patterns = [
    r'(\w+)\s*=\s*([a-zA-Z0-9$_]+)\^([a-zA-Z0-9$_]+)',
    r'var\s+(\w+)\s*=\s*([a-zA-Z0-9$_]+)\^([a-zA-Z0-9$_]+)'
]

matches = 0
for m in re.finditer(r'\b[a-zA-Z0-9$_]+\s*=\s*function\s*\(\s*B\s*,\s*l\s*,\s*p\b', js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 1000)
    print(f"Candidate function definition at {m.start()}:\n{js[m.start():end]}\n{'-'*50}")
    matches += 1

print(f"Total candidate matches: {matches}")
