with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# 1. Parse R array
match_r = re.search(r'var R=\'(.*?)\'\.split\(";"\)', js)
if not match_r:
    match_r = re.search(r"var R='(.*?)'\.split\(';'\)", js)

r_str = match_r.group(1)
R = r_str.split(";")

splice_idx = R.index('splice')
length_idx = R.index('length')
reverse_idx = R.index('reverse')

print(f"R size: {len(R)}, splice: {splice_idx}, length: {length_idx}, reverse: {reverse_idx}")

# 2. Find el, extract Tl, Oe, P_ and the arguments B, l from Tl call in el
pattern_el = r'el\s*=\s*function\s*\(\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*\)\s*\{.*?\.set\(\s*"alr"\s*,\s*"yes"\s*\)\s*;\s*\3\s*&&\s*\(\s*\3\s*=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*,\s*\1\[.*?\]\(\s*\2\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*\)'

match_el = re.search(pattern_el, js)
if not match_el:
    print("Failed to match el function")
    exit(1)

tl_name = match_el.group(4)
oe_name = match_el.group(7)
p_name = match_el.group(8)
b_val = int(match_el.group(5))
l_val = int(match_el.group(6))
w_val = l_val ^ b_val

print(f"Extracted Tl: {tl_name}, Oe: {oe_name}, P_: {p_name}")
print(f"Extracted B: {b_val}, l: {l_val} -> W: {w_val}")

# 3. Find helper object name and method mappings
pattern_helper = rf'var\s+([a-zA-Z0-9$_]+)\s*=\s*\{{\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{{\s*[a-zA-Z0-9$_]+\s*\[\s*R\s*\[\s*{splice_idx}\s*\]\s*\]\s*\(\s*0\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\}}\s*,\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{{.*?\}}\s*,\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*\)\s*\{{.*?\}}\s*\}}'

match_helper = re.search(pattern_helper, js)
if not match_helper:
    print("Failed to match helper object")
    exit(1)

helper_name = match_helper.group(1)
helper_methods = {
    match_helper.group(2): 'splice',
    match_helper.group(3): 'swap',
    match_helper.group(4): 'reverse'
}
print(f"Helper {helper_name} methods: {helper_methods}")

# 4. Find the deciphering block in Tl definition
# The Tl definition starts with: \bTl\s*=\s*function\b
pattern_tl_def = rf'\b{tl_name}\s*=\s*function\b'
match_tl_def = re.search(pattern_tl_def, js)
if not match_tl_def:
    print(f"Failed to find {tl_name} function definition")
    exit(1)

# Find the deciphering block inside Tl: if(!((B^51)>>3)){...}
# We can search in the next 10,000 characters for the block
tl_body = js[match_tl_def.start():match_tl_def.start() + 10000]
decipher_block_match = re.search(r'if\s*\(\s*!\s*\(\s*\(\s*B\s*\^\s*51\s*\)\s*>>\s*3\s*\)\s*\)\s*\{([^}]+)\}', tl_body)
if not decipher_block_match:
    print("Failed to find decipher block inside Tl")
    exit(1)

block_content = decipher_block_match.group(1)
print(f"Decipher block content: {block_content}")

# Parse individual helper method calls in the block, e.g.:
# OD[R[W^5818]](P,W^5881);
# OD[R[W^5852]](P,2);
# OD[R[W^5812]](P,W^5887);
# Format is: helper_name[R[W^<xor_index>]](P, <arg>) or helper_name[R[W^<xor_index>]](P)
# Let's write a regex to find all matches of helper_name[R[W^...]] in the block
call_pattern = rf'{helper_name}\[\s*R\s*\[\s*W\s*\^\s*(\d+)\s*\]\s*\]\(\s*P\s*(?:,\s*([^)]+))?\s*\)'

instructions = []
for m in re.finditer(call_pattern, block_content):
    method_xor = int(m.group(1))
    method_idx = w_val ^ method_xor
    method_name = R[method_idx]
    op_type = helper_methods.get(method_name)
    
    arg_str = m.group(2)
    arg_val = 0
    if arg_str:
        arg_str = arg_str.strip()
        if arg_str.isdigit():
            arg_val = int(arg_str)
        else:
            # Matches W^<xor>
            arg_xor_match = re.match(r'W\s*\^\s*(\d+)', arg_str)
            if arg_xor_match:
                arg_val = w_val ^ int(arg_xor_match.group(1))
            else:
                print(f"Warning: could not parse argument string: {arg_str}")
    
    print(f"Parsed operation: {op_type} with arg: {arg_val} (method: {method_name}, XOR: {method_xor})")
    instructions.append({'op': op_type, 'arg': arg_val})

# Let's test deciphering a sample signature!
# Sample: "a1b2c3d4e5f6g7h8i9j0"
sig = "a1b2c3d4e5f6g7h8i9j0"
arr = list(sig)
for inst in instructions:
    op = inst['op']
    val = inst['arg']
    if op == 'reverse':
        arr.reverse()
    elif op == 'splice':
        arr = arr[val:] # splice(0, val) in JS deletes first val elements
    elif op == 'swap':
        # Swap first element with index val
        tmp = arr[0]
        arr[0] = arr[val % len(arr)]
        arr[val % len(arr)] = tmp

deciphered = "".join(arr)
print(f"Deciphered: {sig} -> {deciphered}")
