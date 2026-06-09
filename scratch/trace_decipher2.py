import re

with open("scratch/base_new.js", "r", encoding="utf-8") as f:
    js = f.read()

# The iv function uses:
# - c[] array for method lookups
# - Nx helper object with methods like Nx[c[S^612]], Nx[c[S^603]], Nx[c[S^613]]
# - Operations: x[c[S^589]](c[S^597]) = x.split("")  then  t[c[S^622]](c[S^597]) = t.join("")
# - So the iv function IS the classic decipher (split -> operations -> join)

# Let's find the Nx helper object
print("=== Looking for Nx helper object ===")
nx_match = re.search(r'\bNx\s*=\s*\{', js)
if nx_match:
    # Find balanced braces
    body_start = nx_match.end() - 1
    depth = 1
    pos = body_start + 1
    while depth > 0 and pos < len(js):
        if js[pos] == '{': depth += 1
        elif js[pos] == '}': depth -= 1
        pos += 1
    body = js[nx_match.start():pos]
    print(f"Nx object: {body[:1000]}")

# Let's find the c array by looking for a large array literal
print("\n=== Looking for c array (large string array) ===")
# The c variable is likely defined at the top level as: var c = ["string1", "string2", ...]
# Or it could be: c = ["...", "...", ...]

# Search for large array assignments near the beginning
for m in re.finditer(r'\bc\s*=\s*\[', js):
    # Check context 
    pre_context = js[max(0, m.start()-20):m.start()]
    # Get the array content (find matching ])
    start = m.end()
    depth = 1
    pos = start
    while depth > 0 and pos < len(js) and pos - start < 50000:
        if js[pos] == '[': depth += 1
        elif js[pos] == ']': depth -= 1
        pos += 1
    if depth == 0:
        arr_content = js[start:pos-1]
        # Count elements
        elements = arr_content.count(',')
        if elements > 20:
            print(f"Found c array at index {m.start()} ({elements+1} elements)")
            print(f"  Context before: ...{pre_context}")
            print(f"  First 500 chars: {arr_content[:500]}")
            
            # Parse the array - extract string values
            strings = re.findall(r'"([^"]*)"', arr_content[:5000])
            print(f"  First 30 string values: {strings[:30]}")
            
            # Check key indices
            if len(strings) > 30:
                for idx in [7, 17, 22, 26, 28, 42]:
                    if idx < len(strings):
                        print(f"  c[{idx}] = \"{strings[idx]}\"")

# Now let's look at the iv function more carefully and extract the S value
# iv(21, 595, ...) -> S = K ^ R = 595 ^ 21 = ?
S_val = 595 ^ 21
print(f"\n=== iv XOR value S = 595 ^ 21 = {S_val} ===")

# In iv function, the decipher block is:
# if((R-3&10)<5&&R-3>=9) which is: if((21-3&10)<5 && 21-3>=9) = if((18&10)<5 && 18>=9) = if(2<5 && true) = TRUE
# So the decipher block DOES execute for R=21

# The operations are:
# t = x[c[S^589]](c[S^597])   -> x.split("")
# Nx[c[S^612]](t, 2)          -> Nx.???(t, 2)
# Nx[c[S^603]](t, S^628)      -> Nx.???(t, S^628)
# Nx[c[S^612]](t, 2)          -> Nx.???(t, 2)
# Nx[c[S^613]](t, S^599)      -> Nx.???(t, S^599)
# Nx[c[S^603]](t, S^609)      -> Nx.???(t, S^609)
# Nx[c[S^613]](t, S^517)      -> Nx.???(t, S^517)
# Nx[c[S^613]](t, S^584)      -> Nx.???(t, S^584)
# Nx[c[S^603]](t, S^616)      -> Nx.???(t, S^616)
# p = t[c[S^622]](c[S^597])   -> t.join("")

print(f"\niv decipher XOR lookups (S={S_val}):")
for xor_val in [589, 597, 612, 603, 628, 613, 599, 609, 517, 584, 616, 622]:
    idx = S_val ^ xor_val
    print(f"  S^{xor_val} = {S_val}^{xor_val} = {idx}")
