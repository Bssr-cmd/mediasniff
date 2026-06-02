import urllib.request
import re
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def main():
    # Fetch a YouTube watch page to get the latest base.js
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

    # Extract base.js path
    js_url = None
    m = re.search(r'"jsUrl"\s*:\s*"([^"]+)"', html)
    if m:
        js_url = m.group(1)
    else:
        m = re.search(r'href="([^"]+base\.js)"', html)
        if m:
            js_url = m.group(1)
        else:
            m = re.search(r'"assets"\s*:\s*\{\s*"js"\s*:\s*"([^"]+)"', html)
            if m:
                js_url = m.group(1)

    if not js_url:
        print("Could not find base.js url in HTML")
        # Let's try some typical base.js paths or pattern matches
        m = re.search(r'/s/player/[a-zA-Z0-9_-]+/player_ias\.vflset/[a-zA-Z0-9_/-]+/base\.js', html)
        if m:
            js_url = m.group(0)

    if not js_url:
        print("HTML sample of head:")
        print(html[:2000])
        return

    if js_url.startswith('//'):
        js_url = 'https:' + js_url
    elif js_url.startswith('/'):
        js_url = 'https://www.youtube.com' + js_url

    print(f"Latest base.js URL: {js_url}")

    req_js = urllib.request.Request(
        js_url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    with urllib.request.urlopen(req_js, context=ctx) as response:
        js = response.read().decode('utf-8')

    print(f"Downloaded base.js (size: {len(js)} bytes)")

    # Find where signature decipher functions might be
    # Usually they contain a split and a join. Let's find patterns like:
    # .split("") or split('') or any property lookup like ["split"] or similar
    # Let's search for references to ".split" or similar in a function
    # Let's print out lines around things matching split
    print("Searching for split/join patterns...")
    
    # Let's search for function body with split/join or lookups
    # Let's find functions that do split and join
    matches = []
    
    # 1. Look for .split("") and .join("")
    for m in re.finditer(r'split\b', js):
        start = max(0, m.start() - 150)
        end = min(len(js), m.end() + 150)
        print(f"Match split at {m.start()}:\n{js[start:end]}\n{'-'*50}")

if __name__ == '__main__':
    main()
