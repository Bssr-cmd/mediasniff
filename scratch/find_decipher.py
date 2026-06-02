import urllib.request
import re
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def find_decipher():
    js_url = "https://www.youtube.com/s/player/c2f7551f/player_ias.vflset/en_GB/base.js"
    print(f"Fetching: {js_url}")
    
    req = urllib.request.Request(js_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx) as response:
        js = response.read().decode('utf-8')
        
    print("Searching for split/join patterns...")
    
    # Search for all matches of .split("") or .split('') inside functions
    # Let's find any occurrences of "split" near "join" in the JS
    matches = re.finditer(r'split\((?:"(?:\\")?"|\'(?:\\\')?\')\)', js)
    for m in matches:
        start = max(0, m.start() - 100)
        end = min(len(js), m.end() + 200)
        snippet = js[start:end]
        if "join" in snippet:
            print(f"--- MATCH AT INDEX {m.start()} ---")
            print(snippet)
            print("-" * 40)

if __name__ == '__main__':
    find_decipher()
