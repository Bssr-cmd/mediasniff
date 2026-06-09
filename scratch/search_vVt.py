with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

print("Searching for vVt:")
for m in re.finditer(r'\bvVt\b', js):
    start = max(0, m.start() - 150)
    end = min(len(js), m.end() + 150)
    print(f"Match at {m.start()}:\n{js[start:end]}\n{'-'*50}")
