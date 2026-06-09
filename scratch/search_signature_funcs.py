with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

for name in ['Oe', 'Tl', 'P_']:
    print(f"Searching for definition of {name}:")
    # Try finding exact assignment/declaration
    for pattern in [
        rf'\b{name}\s*=\s*function\b',
        rf'\bvar\s+{name}\s*=\s*',
        rf'\bfunction\s+{name}\b'
    ]:
        for m in re.finditer(pattern, js):
            start = max(0, m.start() - 100)
            end = min(len(js), m.end() + 1500)
            print(f"Pattern {pattern} matched at {m.start()}:\n{js[m.start():end]}\n{'-'*50}")
