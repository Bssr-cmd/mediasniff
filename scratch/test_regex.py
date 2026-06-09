with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Use non-greedy .*? to match the bracket index, allowing nested brackets
pattern = r'el\s*=\s*function\s*\(\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*\)\s*\{.*?\.set\(\s*"alr"\s*,\s*"yes"\s*\)\s*;\s*\3\s*&&\s*\(\s*\3\s*=\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*,\s*\1\[.*?\]\(\s*\2\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*\)'

match = re.search(pattern, js)
if match:
    print("Found match!")
    print(f"Full matched string: {match.group(0)}")
    print(f"Tl function name: {match.group(4)}")
    print(f"Oe function name: {match.group(5)}")
    print(f"P_ function name: {match.group(6)}")
else:
    print("No match found")
