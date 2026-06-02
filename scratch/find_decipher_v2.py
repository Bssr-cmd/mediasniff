import re
import os

def main():
    coapp_dir = "c:\\Users\\think\\.gemini\\antigravity\\scratch\\mediasniff\\coapp"
    # Find any base.js files that might have been downloaded or cached, or download the latest one from the script we just ran
    # Wait, the latest script downloaded base.js but didn't save it!
    # Let's download it and save it locally, then search it.
    import urllib.request
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    with urllib.request.urlopen(req, context=ctx) as response:
        html = response.read().decode('utf-8')

    js_url = None
    m = re.search(r'"jsUrl"\s*:\s*"([^"]+)"', html)
    if m:
        js_url = m.group(1)
    else:
        m = re.search(r'href="([^"]+base\.js)"', html)
        if m:
            js_url = m.group(1)

    if js_url.startswith('//'):
        js_url = 'https:' + js_url
    elif js_url.startswith('/'):
        js_url = 'https://www.youtube.com' + js_url

    print(f"Downloading {js_url}...")
    req_js = urllib.request.Request(
        js_url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    with urllib.request.urlopen(req_js, context=ctx) as response:
        js = response.read().decode('utf-8')

    # Save to a local temp file so we can analyze it repeatedly
    js_path = "scratch/base.js"
    os.makedirs("scratch", exist_ok=True)
    with open(js_path, "w", encoding="utf-8") as f:
        f.write(js)
    print(f"Saved base.js to {js_path}")

    # Let's search for signature decipher patterns in `js`!
    # A classic signature decipher function looks like:
    # function(a) { a = a.split(""); helper.method1(a, 3); helper.method2(a, 2); ... return a.join(""); }
    # Or in the obfuscated form:
    # function(a) { a = a[X](""); helper.method1(a, 3); helper.method2(a, 2); ... return a[Y](""); }
    # Let's find functions that do something like:
    # z = z.split("") or z = z[something]("") or split/join with bracket notation
    # Let's search for functions matching:
    # function(a){a=a.split("") or function(a){a=a[something]("")
    # Let's write a regex that matches any function taking one variable,
    # then assigning that variable to itself split/sliced/indexed and doing split/join.
    
    # Wait, let's search for patterns:
    # 1. Any function definition like `var xxx = function(a){a=a.` or `xxx = function(a){`
    # Let's find all function definitions with 1 argument that match:
    # `([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*`
    
    print("\n--- Searching for standard split/join ---")
    func_regex = r'([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\('
    for m in re.finditer(func_regex, js):
        print(f"Standard function match: {js[m.start():m.start()+300]}")

    print("\n--- Searching for bracket split/join ---")
    # Matches: z=z[X]("") or z=z[X]('') or z=z[X.Y]("")
    bracket_regex = r'([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\[[^\]]+\]\(\s*(?:""|\'\'|)\s*\)'
    for m in re.finditer(bracket_regex, js):
        print(f"Bracket function match: {js[m.start():m.start()+400]}")

    # Let's find any function containing `.split("")` or `["split"]("")`
    # Let's do a wider search for signature decipher functions:
    # Let's look for:
    # `[a-zA-Z0-9$_]+\[[a-zA-Z0-9$_]+\]\(\s*""\s*\)` or `[a-zA-Z0-9$_]+\[[a-zA-Z0-9$_]+\]\(\s*\'\'\s*\)`
    # inside a function body.
    print("\n--- Searching for any split/join using dynamic properties ---")
    dynamic_split_regex = r'([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\[([a-zA-Z0-9$_.]+)\.([a-zA-Z0-9$_]+)\]\('
    for m in re.finditer(dynamic_split_regex, js):
        print(f"Dynamic property function match: {js[m.start():m.start()+400]}")

    # Let's look for functions with 3 helper operations.
    # Usually there is a helper object like:
    # var JO = {
    #   Xp: function(a, b) { a.splice(0, b) },
    #   t7: function(a) { a.reverse() },
    #   l2: function(a, b) { var c = a[0]; a[0] = a[b % a.length]; a[b % a.length] = c }
    # };
    # Let's search for `.reverse()` or `.splice(0,` in functions with brace boundaries.
    print("\n--- Searching for reverse/splice helper patterns ---")
    helper_regex = r'reverse\s*\(\s*\)|splice\s*\(\s*0\s*,'
    for m in re.finditer(helper_regex, js):
        start = max(0, m.start() - 150)
        end = min(len(js), m.end() + 150)
        print(f"Helper candidate at {m.start()}:\n{js[start:end]}\n{'-'*50}")

if __name__ == '__main__':
    main()
