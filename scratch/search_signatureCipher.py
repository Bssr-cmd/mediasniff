with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Find all occurrences of "signatureCipher"
print("Searching for occurrences of signatureCipher:")
for m in re.finditer(r'signatureCipher', js):
    start = max(0, m.start() - 200)
    end = min(len(js), m.end() + 200)
    print(f"Match at {m.start()}:\n{js[start:end]}\n{'-'*50}")
