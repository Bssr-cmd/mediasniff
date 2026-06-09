import re

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()

print(f"File size: {len(js)} bytes")

# 1. Find R array (or equivalent) using exact pattern from working test
match_r = re.search(r"var R='(.*?)'\.split\(\";\"\)", js)
if not match_r:
    match_r = re.search(r"var\s+R\s*=\s*'([^']+)'\.split\(", js)
if not match_r:
    # Try any variable name with split pattern (more generic)
    match_r = re.search(r"var\s+([a-zA-Z0-9$_]+)\s*=\s*'([^']+)'\.split\(\s*\";\"\s*\)", js)
    if match_r:
        print(f"R-array variable name: {match_r.group(1)}")
        r_str = match_r.group(2)
    else:
        print("R array NOT found with any pattern")
        # Try even more generic
        for m in re.finditer(r"var\s+([a-zA-Z]{1,3})\s*=\s*'([^']{50,})'\.split\(", js):
            print(f"  Candidate array: name={m.group(1)}, length={len(m.group(2))}")
            if 'splice' in m.group(2):
                print(f"  ^ This one contains 'splice'!")
                match_r = m
                break

if match_r:
    if match_r.lastindex == 1:
        r_str = match_r.group(1)
    elif match_r.lastindex == 2:
        r_str = match_r.group(2)
    else:
        r_str = match_r.group(1)
    
    # Detect separator
    context = js[match_r.end():match_r.end()+20]
    R = r_str.split(";")
    print(f"\nR array: size={len(R)}")
    if 'splice' in R:
        print(f"  splice at index {R.index('splice')}")
    if 'reverse' in R:
        print(f"  reverse at index {R.index('reverse')}")
    if 'length' in R:
        print(f"  length at index {R.index('length')}")

# 2. Check for 'el' function (signature URL generation)
el_matches = list(re.finditer(r'el\s*=\s*function\s*\(', js))
print(f"\n'el = function(' matches: {len(el_matches)}")

# 3. Check for 'alr' string (used in el function)
alr_count = js.count('"alr"')
print(f"'alr' mentions: {alr_count}")

# 4. Check for classic split/join decipher
classic = re.search(
    r'([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\(\s*(?:""|\'\')\s*\);\s*([^}]+)\s*return\s+\2\.join\(\s*(?:""|\'\')\s*\)\s*\}',
    js
)
if classic:
    print(f"\nClassic decipher FOUND: name={classic.group(1)}")
    print(f"  Body preview: {classic.group(3)[:300]}")
else:
    print("\nClassic decipher NOT found")

# 5. Check for helper objects with splice/swap/reverse
helper_matches = list(re.finditer(r'var\s+([a-zA-Z0-9$_]+)\s*=\s*\{[^}]*splice[^}]*\}', js))
print(f"\nHelper objects with 'splice': {len(helper_matches)}")
for m in helper_matches[:3]:
    print(f"  {m.group(1)} at pos {m.start()}")

# 6. Check signatureCipher usage
print(f"\nsignatureCipher count: {js.count('signatureCipher')}")
print(f"cipher count: {js.count('cipher')}")

# 7. Try exact pattern from working test on new file
print("\n--- Testing exact pattern from working test ---")
match_el = re.search(
    r'el\s*=\s*function\s*\(\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*\)\s*\{.*?\.set\(\s*"alr"\s*,\s*"yes"\s*\)\s*;\s*\3\s*&&\s*\(\s*\3\s*=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*,\s*\1\[.*?\]\(\s*\2\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*\)',
    js
)
if match_el:
    tl_name = match_el.group(4)
    oe_name = match_el.group(7)
    p_name = match_el.group(8)
    b_val = int(match_el.group(5))
    l_val = int(match_el.group(6))
    w_val = l_val ^ b_val
    print(f"el pattern MATCHED!")
    print(f"  Tl={tl_name}, Oe={oe_name}, P_={p_name}")
    print(f"  B={b_val}, l={l_val}, W={w_val}")
else:
    print("el pattern NOT matched on new base.js")
    # Show context around 'alr' to debug
    alr_idx = js.find('"alr"')
    if alr_idx != -1:
        print(f"\nContext around 'alr' (index {alr_idx}):")
        print(js[max(0,alr_idx-500):alr_idx+500])
