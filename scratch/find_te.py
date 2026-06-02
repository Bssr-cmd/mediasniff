with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re
print("Searching for TE definition in base.js")
for m in re.finditer(r'\bTE\s*=', js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 300)
    print(f"TE definition: {js[start:end]}\n{'-'*50}")
