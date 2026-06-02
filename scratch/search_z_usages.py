with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re
print("Searching for Z_ usages in base.js")
for m in re.finditer(r'\bZ_\b', js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 200)
    print(f"Z_ usage at {m.start()}:\n{js[start:end]}\n{'-'*50}")
