import urllib.request
import re
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def test():
    print("1. Fetching live watch page...")
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            html = response.read().decode('utf-8')
    except Exception as e:
        print(f"Failed to fetch watch page: {e}")
        return

    print("2. Extracting player JS asset URL...")
    js_url_match = re.search(r'"jsUrl"\s*:\s*"([^"]+)"', html) or re.search(r'href="([^"]+base\.js)"', html)
    if not js_url_match:
        js_url_match = re.search(r'/s/player/[a-zA-Z0-9_-]+/player_ias\.vflset/[a-zA-Z0-9_/-]+/base\.js', html)

    if not js_url_match:
        print("Failed to find base.js URL")
        return

    js_url = js_url_match.group(1) if hasattr(js_url_match, 'group') else js_url_match.group(0)
    if js_url.startswith('//'):
        js_url = 'https:' + js_url
    elif js_url.startswith('/'):
        js_url = 'https://www.youtube.com' + js_url

    print(f"Fetching player script: {js_url}")
    try:
        req_js = urllib.request.Request(js_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req_js, context=ctx) as response:
            js = response.read().decode('utf-8')
    except Exception as e:
        print(f"Failed to fetch JS: {e}")
        return

    print("3. Executing decipher extraction logic...")
    try:
        # Extract R array
        match_r = re.search(r'var R=\'(.*?)\'\.split\(";"\)', js)
        if not match_r:
            match_r = re.search(r"var R='(.*?)'\.split\(';'\)", js)
        
        if not match_r:
            print("Failed to find R array definition")
            return
            
        r_str = match_r.group(1)
        R = r_str.split(";")
        r_array_name = "R" # or matched variable name
        
        splice_idx = R.index('splice')
        length_idx = R.index('length')
        reverse_idx = R.index('reverse')
        
        print(f"Parsed R array. Splice idx: {splice_idx}, Length idx: {length_idx}, Reverse idx: {reverse_idx}")
        
        # Match el function
        pattern_el = r'el\s*=\s*function\s*\(\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*,\s*([a-zA-Z0-9$_]+)\s*\)\s*\{.*?\.set\(\s*"alr"\s*,\s*"yes"\s*\)\s*;\s*\3\s*&&\s*\(\s*\3\s*=\s*([a-zA-Z0-9$_]+)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*,\s*\1\[.*?\]\(\s*\2\s*,\s*([a-zA-Z0-9$_]+)\s*\(\s*\d+\s*,\s*\d+\s*,\s*\3\s*\)\s*\)\s*\)'
        match_el = re.search(pattern_el, js)
        if not match_el:
            print("Failed to match el function")
            return
            
        tl_name = match_el.group(4)
        oe_name = match_el.group(7)
        p_name = match_el.group(8)
        b_val = int(match_el.group(5))
        l_val = int(match_el.group(6))
        w_val = l_val ^ b_val
        
        print(f"Extracted Tl: {tl_name}, Oe: {oe_name}, P_: {p_name}")
        print(f"Extracted B: {b_val}, l: {l_val} -> W: {w_val}")
        
        # Match helper object
        pattern_helper = rf'var\s+([a-zA-Z0-9$_]+)\s*=\s*\{{\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{{\s*[a-zA-Z0-9$_]+\s*\[\s*R\s*\[\s*{splice_idx}\s*\]\s*\]\s*\(\s*0\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\}}\s*,\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*,\s*[a-zA-Z0-9$_]+\s*\)\s*\{{.*?\}}\s*,\s*([a-zA-Z0-9$_]+)\s*:\s*function\s*\(\s*[a-zA-Z0-9$_]+\s*\)\s*\{{.*?\}}\s*\}}'
        match_helper = re.search(pattern_helper, js)
        if not match_helper:
            print("Failed to match helper object")
            return
            
        helper_name = match_helper.group(1)
        helper_methods = {
            match_helper.group(2): 'splice',
            match_helper.group(3): 'swap',
            match_helper.group(4): 'reverse'
        }
        print(f"Helper {helper_name} methods: {helper_methods}")
        
        # Find deciphering block in Tl definition
        pattern_tl_def = rf'\b{tl_name}\s*=\s*function\b'
        match_tl_def = re.search(pattern_tl_def, js)
        if not match_tl_def:
            print(f"Failed to find {tl_name} function definition")
            return
            
        tl_body = js[match_tl_def.start():match_tl_def.start() + 10000]
        decipher_block_match = re.search(r'if\s*\(\s*!\s*\(\s*\(\s*B\s*\^\s*51\s*\)\s*>>\s*3\s*\)\s*\)\s*\{([^}]+)\}', tl_body)
        if not decipher_block_match:
            print("Failed to find decipher block inside Tl")
            return
            
        block_content = decipher_block_match.group(1)
        print(f"Decipher block content: {block_content}")
        
        # Parse method calls in the block
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
                    arg_xor_match = re.match(r'W\s*\^\s*(\d+)', arg_str)
                    if arg_xor_match:
                        arg_val = w_val ^ int(arg_xor_match.group(1))
            
            print(f"Operation: {op_type} with arg: {arg_val}")
            instructions.append({'op': op_type, 'arg': arg_val})
            
        if not instructions:
            print("No operations parsed")
            return
            
        sig = "a1b2c3d4e5f6g7h8i9j0"
        arr = list(sig)
        for inst in instructions:
            op = inst['op']
            val = inst['arg']
            if op == 'reverse':
                arr.reverse()
            elif op == 'splice':
                arr = arr[val:]
            elif op == 'swap':
                tmp = arr[0]
                arr[0] = arr[val % len(arr)]
                arr[val % len(arr)] = tmp
                
        deciphered = "".join(arr)
        print(f"TEST SUCCESS: {sig} -> {deciphered}")
        
    except Exception as e:
        print(f"Parsing failed: {e}")

if __name__ == '__main__':
    test()
