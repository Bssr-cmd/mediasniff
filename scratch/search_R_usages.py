with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

print("Searching for R[34] or R[37] or similar:")
for m in re.finditer(r'R\[\d+\]', js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 150)
    # Check if this context contains split or join
    print(f"Match: {js[start:end]}\n{'-'*50}")
    # Let's limit the number of outputs
    if m.start() > 500000:
        break
