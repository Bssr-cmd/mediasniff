with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re
print("Searching for e[2] (split) and e[8] (join) usages in base.js")

# Let's search for e[2]
# It could be written as e[2] or e[0x2]
pattern_split = r'\[\s*e\s*\[\s*2\s*\]\s*\]'
for m in re.finditer(pattern_split, js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 200)
    print(f"e[2] match at {m.start()}:\n{js[start:end]}\n{'-'*50}")

# Let's search for e[8]
pattern_join = r'\[\s*e\s*\[\s*8\s*\]\s*\]'
for m in re.finditer(pattern_join, js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 200)
    print(f"e[8] match at {m.start()}:\n{js[start:end]}\n{'-'*50}")

# Let's search for any bracket lookup containing a split/join on the string variable `e`
# like `[e[some_idx]]("")`
pattern_dynamic = r'\[\s*e\s*\[\s*(\d+)\s*\]\s*\]\(\s*(?:""|\'\'|)\s*\)'
for m in re.finditer(pattern_dynamic, js):
    start = max(0, m.start() - 100)
    end = min(len(js), m.end() + 200)
    print(f"Dynamic split/join match at {m.start()}:\n{js[start:end]}\n{'-'*50}")
