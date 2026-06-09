# Read first 10,000 chars of base.js to get R
with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Match the declaration of R
match = re.search(r'var R=\'(.*?)\'\.split\(";"\)', js)
if not match:
    # try single quote split
    match = re.search(r"var R='(.*?)'\.split\(';'\)", js)

if match:
    r_str = match.group(1)
    r_array = r_str.split(";")
    print(f"R has {len(r_array)} elements. First 100:")
    for idx, val in enumerate(r_array):
        if idx < 100:
            print(f"  {idx}: {val}")
        if val in ['split', 'join', 'reverse', 'slice', 'splice']:
            print(f"  [SPECIAL] {idx}: {val}")
else:
    print("Could not find declaration of R")
