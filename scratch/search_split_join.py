with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Search for function(B){B=B.split("") or B=B[something]("") or split("") in a function
print("Searching for split/join patterns:")
# Let's find functions containing ".split" and ".join"
for m in re.finditer(r'function\s*\(\s*([a-zA-Z0-9$_]+)\s*\)\s*\{\s*\1\s*=\s*\1\.split\(\s*""\s*\)', js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 300)
    print(f"Match: {js[start:end]}\n{'-'*50}")

for m in re.finditer(r'function\s*\(\s*([a-zA-Z0-9$_]+)\s*\)\s*\{\s*\1\s*=\s*\1\.split\(\s*\'\'\s*\)', js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 300)
    print(f"Match (single quote): {js[start:end]}\n{'-'*50}")
