import urllib.request
import re
import sys

# Fetch YouTube homepage to find the current base.js URL
req = urllib.request.Request(
    'https://www.youtube.com',
    headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.5',
    }
)

html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8')

# Find the jsUrl
m = re.search(r'"jsUrl"\s*:\s*"([^"]+)"', html)
if not m:
    m = re.search(r'/s/player/[a-zA-Z0-9_-]+/player_ias\.vflset/[a-zA-Z0-9_/-]+/base\.js', html)

if not m:
    print("ERROR: Could not find base.js URL in YouTube page")
    sys.exit(1)

js_url = m.group(1) if m.lastindex else m.group(0)
if js_url.startswith('//'):
    js_url = 'https:' + js_url
elif js_url.startswith('/'):
    js_url = 'https://www.youtube.com' + js_url

print(f"Current base.js URL: {js_url}")

# Download it
req2 = urllib.request.Request(js_url, headers={
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
})
js_content = urllib.request.urlopen(req2, timeout=30).read().decode('utf-8')
print(f"Downloaded {len(js_content)} bytes")

with open("scratch/base_new.js", "w", encoding="utf-8") as f:
    f.write(js_content)
print("Saved to scratch/base_new.js")

# Quick check: does our R-array pattern still match?
match_r = re.search(r"var R='(.*?)'\\.split\\(\";\"|var R=\"(.*?)\"\\.split\\(\";\"|var\\s+[a-zA-Z0-9$_]+\\s*=\\s*'([^']+)'\\.split\\(\\s*(?:\"|')[;\"](?:\"|')\\s*\\)", js_content)
if match_r:
    r_str = match_r.group(1) or match_r.group(2) or match_r.group(3)
    R = r_str.split(";")
    print(f"\nR array found! Size: {len(R)}")
    print(f"  splice index: {R.index('splice') if 'splice' in R else 'NOT FOUND'}")
    print(f"  reverse index: {R.index('reverse') if 'reverse' in R else 'NOT FOUND'}")
    print(f"  length index: {R.index('length') if 'length' in R else 'NOT FOUND'}")
else:
    # Try broader pattern
    match_r2 = re.search(r"var\s+([a-zA-Z0-9$_]+)\s*=\s*['\"]([^'\"]+)['\"]\s*\.\s*split\s*\(\s*['\"][;{}]['\"]", js_content)
    if match_r2:
        r_name = match_r2.group(1)
        r_str = match_r2.group(2)
        separator_match = re.search(r"split\s*\(\s*['\"](.)['\"]", js_content[match_r2.start():match_r2.end()+10])
        sep = separator_match.group(1) if separator_match else ";"
        R = r_str.split(sep)
        print(f"\nR array found (name={r_name}, sep='{sep}')! Size: {len(R)}")
        print(f"  splice index: {R.index('splice') if 'splice' in R else 'NOT FOUND'}")
    else:
        print("\nR array pattern NOT FOUND - YouTube may have changed obfuscation")

# Check classic split/join decipher pattern
classic = re.search(r'([a-zA-Z0-9$_]+)\s*=\s*function\(([a-zA-Z0-9$_]+)\)\{\s*\2\s*=\s*\2\.split\(\s*(?:""|\'\')\s*\);\s*([^}]+)\s*return\s+\2\.join\(\s*(?:""|\'\')\s*\)\s*\}', js_content)
if classic:
    print(f"\nClassic decipher pattern FOUND: function name = {classic.group(1)}")
    print(f"Body: {classic.group(3)[:200]}")
else:
    print("\nClassic split/join decipher pattern NOT found")

# Check for signatureCipher usage
sc_count = js_content.count('signatureCipher')
cipher_count = js_content.count('"cipher"')
print(f"\nsignatureCipher mentions: {sc_count}")
print(f"cipher mentions: {cipher_count}")
