with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

print("Searching for definition of Oe:")
for pattern in [
    r'\bOe\s*=\s*function\b',
    r'\bvar\s+Oe\s*=\s*',
    r'\bfunction\s+Oe\b'
]:
    for m in re.finditer(pattern, js):
        start = max(0, m.start() - 100)
        end = min(len(js), m.end() + 1500)
        print(f"Pattern {pattern} matched at {m.start()}:\n{js[m.start():end]}\n{'-'*50}")
