with open("scratch/e_def.txt", "r", encoding="utf-8") as f:
    text = f.read()

import re
m = re.search(r'\bvar\s+e\s*=.*?(?:\.split\([^)]+\)|;)', text)
if m:
    print("Found e definition:")
    print(m.group(0))
else:
    print("e definition not found in first 5000 chars.")
