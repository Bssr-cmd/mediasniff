import re

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()

# Find the c array definition
c_match = re.search(r'c="([^"]+)"', js[:5000])
if not c_match:
    c_match = re.search(r"c='([^']+)'", js[:5000])

if not c_match:
    print("c array not found!")
    exit(1)

c_str = c_match.group(1)

# Determine separator - look at what follows the string
after = js[c_match.end():c_match.end()+30]
sep_match = re.search(r'\.split\(\s*"([^"]*)"', after)
if not sep_match:
    sep_match = re.search(r"\.split\(\s*'([^']*)'", after)

sep = sep_match.group(1) if sep_match else "{"
print(f"Separator: '{sep}'")

c = c_str.split(sep)
print(f"c array: {len(c)} elements\n")

# Print all elements
for i, val in enumerate(c):
    print(f"  c[{i}] = \"{val}\"")

# Now decode the iv function operations
print("\n=== Decoding iv function (decipher) ===")
S = 595 ^ 21  # = 582

# From iv function body:
# t = x[c[S^589]](c[S^597])       -> split/join
# Nx[c[S^612]](t, 2)              -> Nx method
# Nx[c[S^603]](t, S^628)          -> Nx method
# Nx[c[S^612]](t, 2)              -> Nx method
# Nx[c[S^613]](t, S^599)          -> Nx method
# Nx[c[S^603]](t, S^609)          -> Nx method
# Nx[c[S^613]](t, S^517)          -> Nx method
# Nx[c[S^613]](t, S^584)          -> Nx method
# Nx[c[S^603]](t, S^616)          -> Nx method
# p = t[c[S^622]](c[S^597])       -> join/split

operations = [
    (589, None, "split call"),
    (597, None, "split arg"),
    (612, 2, "Nx method + literal 2"),
    (603, 628, "Nx method + S^628"),
    (612, 2, "Nx method + literal 2"),
    (613, 599, "Nx method + S^599"),
    (603, 609, "Nx method + S^609"),
    (613, 517, "Nx method + S^517"),
    (613, 584, "Nx method + S^584"),
    (603, 616, "Nx method + S^616"),
    (622, None, "join call"),
    (597, None, "join arg"),
]

# Nx methods: ue = swap, bi = reverse, jR = splice
nx_methods = {
    'ue': 'SWAP',
    'bi': 'REVERSE',
    'jR': 'SPLICE'
}

print(f"S = {S}")
for xor_val, arg_xor, desc in operations:
    idx = S ^ xor_val
    c_val = c[idx] if idx < len(c) else "OUT OF RANGE"
    if arg_xor is not None and isinstance(arg_xor, int) and arg_xor > 10:
        arg_val = S ^ arg_xor
        nx_op = nx_methods.get(c_val, c_val)
        print(f"  c[{idx}] = \"{c_val}\" ({nx_op}), arg = S^{arg_xor} = {arg_val}   [{desc}]")
    elif arg_xor is not None:
        nx_op = nx_methods.get(c_val, c_val)
        print(f"  c[{idx}] = \"{c_val}\" ({nx_op}), arg = {arg_xor}   [{desc}]")
    else:
        print(f"  c[{idx}] = \"{c_val}\"   [{desc}]")

# Now reconstruct the actual decipher steps
print("\n=== Reconstructed decipher operations ===")
decipher_steps = []
# Parse the iv body more carefully
iv_match = re.search(r'\biv\s*=\s*function\s*\([^)]*\)\s*\{', js)
if iv_match:
    depth = 1
    pos = iv_match.end()
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    iv_body = js[iv_match.start():pos]
    
    # Find the decipher block: the one with split -> Nx calls -> join
    # Look for the Nx calls pattern
    nx_calls = list(re.finditer(r'Nx\[c\[S\^(\d+)\]\]\(t,\s*(?:(\d+)|S\^(\d+))\)', iv_body))
    print(f"Found {len(nx_calls)} Nx calls in iv function")
    
    for call in nx_calls:
        method_xor = int(call.group(1))
        method_idx = S ^ method_xor
        method_name = c[method_idx] if method_idx < len(c) else "?"
        op = nx_methods.get(method_name, method_name)
        
        if call.group(2):
            arg = int(call.group(2))
        else:
            arg = S ^ int(call.group(3))
        
        print(f"  {op}({arg})  [Nx.{method_name}, c[{method_idx}]]")
        decipher_steps.append((op, arg))

# Test with sample signature
print("\n=== Test decipher ===")
test_sig = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
arr = list(test_sig)
for op, arg in decipher_steps:
    if op == 'SWAP':
        idx = arg % len(arr)
        arr[0], arr[idx] = arr[idx], arr[0]
    elif op == 'REVERSE':
        arr.reverse()
    elif op == 'SPLICE':
        arr = arr[arg:]
print(f"Input:  {test_sig}")
print(f"Output: {''.join(arr)}")

# Also print the K2 function decipher operation
print("\n=== K2 function analysis ===")
print("K2 contains: x[c[26]](0,1,x[c[26]](X,1,x[0])[0])")
print(f"c[26] = \"{c[26]}\" -> this is a splice-based SWAP")
print("K2(43, 6163, x) -> Z = 6163 ^ 43 = 6200")
print("The K2 call with R=43: (R+6&28)>=R && R+8>>2<R checks if this executes")
r_val = 43
print(f"  (R+6&28)>=R: ({r_val+6}&28)>={r_val} -> {(r_val+6)&28}>={r_val} -> {((r_val+6)&28) >= r_val}")
print(f"  R+8>>2<R: {r_val+8}>>2<{r_val} -> {(r_val+8)>>2}<{r_val} -> {((r_val+8)>>2) < r_val}")
