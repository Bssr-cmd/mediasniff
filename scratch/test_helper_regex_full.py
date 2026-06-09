with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Match the declaration of R
match_r = re.search(r'var R=\'(.*?)\'\.split\(";"\)', js)
if not match_r:
    match_r = re.search(r"var R='(.*?)'\.split\(';'\)", js)

r_str = match_r.group(1)
R = r_str.split(";")

splice_idx = R.index('splice')
length_idx = R.index('length')
reverse_idx = R.index('reverse')

# Match the full helper object
pattern = rf'var\s+([a-zA-Z0-9$_]+)\s*=\s*\{{\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{{\s*[a-zA-Z0-9$_]+\s*\[\s*R\s*\[\s*{splice_idx}\s*\]\s*\]\s*\(\s*0\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\}}\s*,\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{{.*?\}}\s*,\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*\)\s*\{{.*?\}}\s*\}}'

match = re.search(pattern, js)
if match:
    print("Found helper match!")
    print(f"Helper name: {match.group(1)}")
    print(f"Splice method: {match.group(2)}")
    print(f"Swap method: {match.group(3)}")
    print(f"Reverse method: {match.group(4)}")
    print(f"Full matched string: {match.group(0)}")
else:
    print("Helper match not found")
