import re, json

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()

# The Nx object has methods: ue (swap), bi (reverse), jR (splice)
# In the iv function:
#   Nx[c[34]](t, 2)      -> one of ue/bi/jR
#   Nx[c[29]](t, S^628)  -> one of ue/bi/jR
#   Nx[c[35]](t, S^599)  -> one of ue/bi/jR
# 
# So we need c[34], c[29], c[35] which should be "ue", "bi", or "jR"

# Let's find the c array. It might be defined differently.
# Search for it near the Nx definition
nx_idx = js.find("Nx={")
print(f"Nx object found at index {nx_idx}")

# Look for c=["..."] or var c=["..."] in the first part of the file
# The c array might use a different delimiter or be defined as a computed expression

# Let's try to find any array that contains "ue", "bi", "jR" strings
print("\n=== Searching for arrays containing 'ue', 'bi', 'jR' ===")
for m in re.finditer(r'"jR"', js):
    # Look backwards for array start
    search_area = js[max(0, m.start()-2000):m.start()]
    arr_start = search_area.rfind('[')
    if arr_start != -1:
        actual_start = max(0, m.start()-2000) + arr_start
        # Find closing bracket
        depth = 1
        pos = actual_start + 1
        while depth > 0 and pos < len(js) and pos - actual_start < 50000:
            if js[pos] == '[': depth += 1
            elif js[pos] == ']': depth -= 1
            pos += 1
        if depth == 0:
            arr_str = js[actual_start:pos]
            elements = arr_str.count(',')
            if elements > 20:
                # Find what variable this is assigned to
                pre = js[max(0, actual_start-30):actual_start]
                var_match = re.search(r'([a-zA-Z0-9$_]+)\s*=\s*$', pre)
                var_name = var_match.group(1) if var_match else "?"
                print(f"Found array '{var_name}' with {elements+1} elements at index {actual_start}")
                
                # Parse string values
                strings = re.findall(r'"([^"]*)"', arr_str)
                print(f"Total string values: {len(strings)}")
                
                # Print key indices
                for i, s in enumerate(strings):
                    if s in ['ue', 'bi', 'jR', 'splice', 'reverse', 'length', 'split', 'join', 'set', '']:
                        print(f"  c[{i}] = \"{s}\"")
                
                # Check the indices used in iv function
                S = 582
                for xor_val, desc in [(589, "split_method"), (597, "split_arg_empty"), 
                                       (612, "Nx_method_1"), (603, "Nx_method_2"),
                                       (628, "arg_1"), (613, "Nx_method_3"),
                                       (599, "arg_2"), (609, "arg_3"),
                                       (517, "arg_4"), (584, "arg_5"),
                                       (616, "arg_6"), (622, "join_method")]:
                    idx = S ^ xor_val
                    if idx < len(strings):
                        print(f"  c[{idx}] (S^{xor_val}, {desc}) = \"{strings[idx]}\"")
                    else:
                        print(f"  c[{idx}] (S^{xor_val}, {desc}) = OUT OF RANGE")

# Also check: K2 function swap operation
# K2 has: x[c[26]](0,1,x[c[26]](X,1,x[0])[0])
# This is: x.splice(0, 1, x.splice(X, 1, x[0])[0]) — which IS a swap
# K2(43, 6163, x) -> Z = 6163 ^ 43 = ?
Z_k2 = 6163 ^ 43
print(f"\nK2 XOR value Z = 6163 ^ 43 = {Z_k2}")
