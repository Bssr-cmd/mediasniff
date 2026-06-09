with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Match the declaration of R
match_r = re.search(r'var R=\'(.*?)\'\.split\(";"\)', js)
if not match_r:
    match_r = re.search(r"var R='(.*?)'\.split\(';'\)", js)

r_str = match_r.group(1)
R = r_str.split(";")

# Let's search for the helper object definition
# E.g. var OD={po:function(B,l){B[R[4]](0,l)},nT:function(B,l){var p=B[0];B[0]=B[l%B[R[9]]];B[l%B[R[9]]]=p},kj:function(B){B[R[72]]()}}
# We can make it generic to find the helper name and its method names.
# R[4] is splice, R[9] is length, R[72] is reverse.
# We want to match:
# var <helper> = { <splice_method>: function(a,b) { a[R[4]](0,b) }, <swap_method>: function(a,b) { ... }, <reverse_method>: function(a) { a[R[72]]() } }

splice_idx = R.index('splice')
length_idx = R.index('length')
reverse_idx = R.index('reverse')

print(f"R indexes - splice: {splice_idx}, length: {length_idx}, reverse: {reverse_idx}")

pattern = rf'var\s+([a-zA-Z0-9$_]+)\s*=\s*\{{\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{{\s*[a-zA-Z0-9$_]+\s*\[\s*R\s*\[\s*{splice_idx}\s*\]\s*\]\s*\(\s*0\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\}}'

match = re.search(pattern, js)
if match:
    print("Found helper match!")
    print(f"Helper name: {match.group(1)}")
    print(f"Splice method: {match.group(2)}")
    
    # Let's extract the whole object definition to parse the other methods
    helper_def_start = match.start()
    helper_def_end = js.find('}', helper_def_start) + 2
    print(f"Full definition: {js[helper_def_start:helper_def_end]}")
else:
    print("Helper match not found")
