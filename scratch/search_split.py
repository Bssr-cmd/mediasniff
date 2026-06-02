import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def search_split():
    js_url = "https://www.youtube.com/s/player/c2f7551f/player_ias.vflset/en_GB/base.js"
    req = urllib.request.Request(js_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx) as response:
        js = response.read().decode('utf-8')
        
    print(f"Total length of base.js: {len(js)} characters.")
    
    # Find all occurrences of "split" in the script
    import re
    matches = [m.start() for m in re.finditer("split", js)]
    print(f"Total occurrences of 'split': {len(matches)}")
    
    for idx in matches[:20]:
        start = max(0, idx - 50)
        end = min(len(js), idx + 100)
        print(f"Index {idx}: ... {js[start:end].strip()} ...")
        print("-" * 50)

if __name__ == '__main__':
    search_split()
