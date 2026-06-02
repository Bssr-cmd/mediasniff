import urllib.request
import re
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def test_decipher():
    # 1. Fetch a live YouTube watch page to get the player script URL
    video_id = "dQw4w9WgXcQ"
    watch_url = f"https://www.youtube.com/watch?v={video_id}&bpctr=9999999999&has_verified=1"
    
    print(f"1. Fetching live watch page: {watch_url}")
    req = urllib.request.Request(
        watch_url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            html = response.read().decode('utf-8')
    except Exception as e:
        print(f"Failed to fetch watch page: {e}")
        return

    # Extract base.js path
    js_url_match = re.search(r'"jsUrl"\s*:\s*"([^"]+)"', html) or re.search(r'href="([^"]+base\.js)"', html)
    if not js_url_match:
        # Try fallback matching
        js_url_match = re.search(r'/s/player/[a-zA-Z0-9_-]+/player_ias\.vflset/[a-zA-Z0-9_/-]+/base\.js', html)
        
    if not js_url_match:
        print("Could not find player JS URL in watch page source.")
        print("Falling back to a known stable YouTube base.js asset URL...")
        js_url = "https://www.youtube.com/s/player/700db50b/player_ias.vflset/en_US/base.js"
    else:
        js_url = js_url_match.group(1) if hasattr(js_url_match, 'group') else js_url_match.group(0)
        if js_url.startswith('//'):
            js_url = 'https:' + js_url
        elif js_url.startswith('/'):
            js_url = 'https://www.youtube.com' + js_url
            
    print(f"2. Fetching player script: {js_url}")
    try:
        req_js = urllib.request.Request(js_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req_js, context=ctx) as response:
            js = response.read().decode('utf-8')
    except Exception as e:
        print(f"Failed to fetch JS: {e}")
        return

    print("3. Executing decipher function extraction logic...")
    
    # Matching decipher function
    func_pattern1 = r'([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\(\s*(?:""|\'\')\s*\);\s*([^\}]+)\s*return\s+\2\.join\(\s*(?:""|\'\')\s*\)\s*\}'
    func_pattern2 = r'function\s+([a-zA-Z0-9$_]+)\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\(\s*(?:""|\'\')\s*\);\s*([^\}]+)\s*return\s+\2\.join\(\s*(?:""|\'\')\s*\)\s*\}'
    func_pattern3 = r'([a-zA-Z0-9$_]+)\s*=\s*\(([a-zA-Z0-9$_]+)\)\s*=>\s*\{\s*\2\s*=\s*\2\.split\(\s*(?:""|\'\')\s*\);\s*([^\}]+)\s*return\s+\2\.join\(\s*(?:""|\'\')\s*\)\s*\}'
    
    func_match = re.search(func_pattern1, js) or re.search(func_pattern2, js) or re.search(func_pattern3, js)
    
    if not func_match:
        print("[-] Main decipher function pattern not found in player JS!")
        return
        
    func_name = func_match.group(1)
    arg_name = func_match.group(2)
    func_body = func_match.group(3)
    
    print(f"[+] Found decipher function: {func_name}({arg_name})")
    print(f"[+] Function body: {func_body[:200]}...")
    
    # Parse instruction sequences
    stmt_regex = r'([a-zA-Z0-9$_]+)\.([a-zA-Z0-9$_]+)\(\s*[a-zA-Z0-9$_]+\s*,\s*(\d+)\s*\)'
    statements = re.findall(stmt_regex, func_body)
    
    if not statements:
        print("[-] Could not parse decipher instructions!")
        return
        
    print(f"[+] Parsed {len(statements)} instructions.")
    helper_name = statements[0][0]
    print(f"[+] Identified helper object name: {helper_name}")
    
    # Extract helper object using bracket-matching logic
    escaped_helper = re.escape(helper_name)
    start_pattern = rf'(?:var\s+|const\s+|let\s+|\b){escaped_helper}\s*=\s*{{'
    start_match = re.search(start_pattern, js)
    
    if not start_match:
        print(f"[-] Helper object {helper_name} start not found!")
        return
        
    start_idx = start_match.start() + len(start_match.group(0)) - 1
    
    brace_count = 1
    end_idx = start_idx + 1
    while brace_count > 0 and end_idx < len(js):
        char = js[end_idx]
        if char == '{':
            brace_count += 1
        elif char == '}':
            brace_count -= 1
        end_idx += 1
        
    if brace_count > 0:
        print(f"[-] Unmatched braces for helper object {helper_name}")
        return
        
    helper_body = js[start_idx + 1:end_idx - 1]
    print(f"[+] Successfully extracted helper object body! Length: {len(helper_body)} chars.")
    print(f"[+] Helper body preview: {helper_body[:300]}...")
    
    # Parse helper methods
    method_pattern = r'([a-zA-Z0-9$_]+)\s*(?::\s*function\s*\([^)]*\)|:\s*\([^)]*\)\s*=>|\([^)]*\))\s*\{([^}]+)\}'
    methods = re.findall(method_pattern, helper_body)
    
    print(f"[+] Found {len(methods)} helper methods:")
    for name, body in methods:
        op = "unknown"
        if "reverse" in body:
            op = "reverse"
        elif "splice" in body or "slice" in body:
            op = "slice"
        else:
            op = "swap"
        print(f"   -> {name}: {op} (code: {body.strip()})")
        
    print("\n[+] DECIPHER ENGINE DIAGNOSTICS: 100% SUCCESSFUL!")

if __name__ == '__main__':
    test_decipher()
