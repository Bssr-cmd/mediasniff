import re

def main():
    with open("scratch/base.js", "r", encoding="utf-8") as f:
        js = f.read()

    # 1. Parse the `e` array strings
    # Pattern: var e="...".split("{")
    e_match = re.search(r'\bvar\s+e\s*=\s*"([^"]+)"', js)
    if not e_match:
        print("Failed to find e array string")
        return
    e_array = e_match.group(1).split("{")
    print(f"Parsed e array (size: {len(e_array)} elements)")
    print(f"e[38] = {e_array[38]}, e[39] = {e_array[39]}, e[25] = {e_array[25]}")

    # 2. Find cC function signature
    # Pattern: cC = function(z, D, E, Q, T, k, G)
    cc_func_match = re.search(r'\bcC\s*=\s*function\s*\(\s*z\s*,\s*D\s*,\s*E\s*,\s*Q\s*,\s*T\s*,\s*k\s*,\s*G\s*\)\s*\{', js)
    if not cc_func_match:
        cc_func_match = re.search(r'\bcC\s*=\s*function\s*\(\s*z\s*,\s*D\s*,\s*E\s*,\s*Q\s*,\s*T\s*,\s*k\s*,\s*G\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{', js)
        
    if not cc_func_match:
        print("Failed to find cC function definition")
        return

    print("Found cC definition")

    # 3. Find the call to cC for signature cipher
    # Pattern: cC(25, 476, Vl(75, 1734, G.s))
    # Let's search for `cC` called with parameters and a `.s` property inside
    cc_call_match = re.search(r'\bcC\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*[A-Za-z0-9$_]+\(\s*\d+\s*,\s*\d+\s*,\s*[A-Za-z0-9$_.]+\.s\s*\)\)', js)
    if not cc_call_match:
        # Fallback to a simpler match for cC(25, 476, ...)
        cc_call_match = re.search(r'\bcC\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*[A-Za-z0-9$_]+\(\s*\d+\s*,\s*\d+\s*,\s*[a-zA-Z0-9$_]+\.s\s*\)\)', js)
    
    if not cc_call_match:
        print("Failed to find signature cC call")
        return

    z_val = int(cc_call_match.group(1))
    d_val = int(cc_call_match.group(2))
    d = d_val ^ z_val
    print(f"Signature cC call matched: cC({z_val}, {d_val}, ...) -> d = {d}")

    # 4. Locate Z_ helper object
    # Pattern: var Z_={Rh:function(z,D){z[e[38]](0,D)},n2:function(z,D){...},mg:function(z){z[e[39]]()}}
    # Let's find it dynamically: search for an object with n2, Rh, mg
    z_helper_match = re.search(r'\b([a-zA-Z0-9$_]+)\s*=\s*\{\s*Rh\s*:\s*function', js)
    if not z_helper_match:
        print("Failed to find Z_ helper object")
        return
    helper_name = z_helper_match.group(1)
    print(f"Found helper object name: {helper_name}")

    # 5. Find the block of calls to Z_ inside cC function body
    # Let's find the text from the start of cC to about 2000 chars after
    cc_start_idx = cc_func_match.start()
    cc_body = js[cc_start_idx : cc_start_idx + 3000]

    # Let's extract the sequence of helper calls on helper_name
    # Pattern: helper_name[e[d^X]](F, Y)
    # We can match: helper_name\[e\[d\^(\d+)\]\]\(\s*[a-zA-Z0-9$_]+\s*,\s*([^)]+)\s*\)
    call_pattern = re.compile(rf'{re.escape(helper_name)}\[e\[d\^(\d+)\]\]\(\s*([a-zA-Z0-9$_]+)\s*,\s*([^)]+)\s*\)')
    
    calls = []
    for match in call_pattern.finditer(cc_body):
        method_xor = int(match.group(1))
        array_var = match.group(2)
        param_str = match.group(3)
        
        # Decode the method name in e array
        method_index = d ^ method_xor
        method_name = e_array[method_index]
        
        # Decode the parameter value (which can be a literal integer, or d^number)
        param_val = 0
        if param_str.isdigit():
            param_val = int(param_str)
        else:
            param_xor_match = re.match(r'd\^(\d+)', param_str)
            if param_xor_match:
                param_val = d ^ int(param_xor_match.group(1))
            else:
                print(f"Unknown parameter expression: {param_str}")
                continue
                
        calls.append((method_name, param_val))
        print(f"Decoded operation: {method_name}({param_val})")

    if not calls:
        print("Failed to decode any operations")
        return

    # Let's map operations to decipher actions
    # Z_ mapping:
    # Rh -> splice (slice)
    # n2 -> swap
    # mg -> reverse
    actions = []
    for method, val in calls:
        if method == "Rh":
            actions.append(f"splice(0, {val})")
        elif method == "n2":
            actions.append(f"swap(0, {val})")
        elif method == "mg":
            actions.append(f"reverse()")
            
    print("\nSuccessfully parsed signature decipher instructions:")
    print(" -> " + " -> ".join(actions))

if __name__ == '__main__':
    main()
