with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

print("Searching for definition of el:")
for pattern in [
    r'\bel\s*=\s*function\b',
    r'\bvar\s+el\s*=\s*',
    r'\bfunction\s+el\b',
    r'\bel\s*=\s*'
]:
    for m in re.finditer(pattern, js):
        start = max(0, m.start() - 100)
        end = min(len(js), m.end() + 1000)
        print(f"Pattern {pattern} matched at {m.start()}:\n{js[m.start():end]}\n{'-'*50}")
        # Only print first few matches to avoid spamming
        break
