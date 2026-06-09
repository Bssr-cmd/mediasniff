with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Find occurrences of R.split or similar
print("Searching for occurrences of R:")
for m in re.finditer(r'\bR\b', js[:100000]):
    start = max(0, m.start() - 50)
    end = min(len(js), m.end() + 100)
    print(f"Match at {m.start()}: {js[start:end]}")
    print("-" * 50)
