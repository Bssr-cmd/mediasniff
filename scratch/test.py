import urllib.request
import re
import json

req = urllib.request.Request('https://www.youtube.com/watch?v=jNQXAC9IVRw', headers={'User-Agent': 'Mozilla/5.0'})
html = urllib.request.urlopen(req).read().decode('utf-8')

match = re.search(r'"(/[^\"]+/base\.js)"', html)
if match:
    js_url = 'https://www.youtube.com' + match.group(1)
    print('Found base.js:', js_url)
    js = urllib.request.urlopen(js_url).read().decode('utf-8')
    with open('base.js', 'w', encoding='utf-8') as f:
        f.write(js)
        
    m1 = re.search(r'\b[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(', js)
    m2 = re.search(r'\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(', js)
    m3 = re.search(r'(?:\.sig\|\|([a-zA-Z0-9$]+)\()', js)
    m4 = re.search(r'\.set\("signature",\s*([a-zA-Z0-9$]+)\(', js)
    
    print('m1:', m1.group(1) if m1 else None)
    print('m2:', m2.group(1) if m2 else None)
    print('m3:', m3.group(1) if m3 else None)
    print('m4:', m4.group(1) if m4 else None)
    
    sig_name = (m1 or m2 or m3 or m4)
    if sig_name:
        name = sig_name.group(1).replace('$', '\\$')
        fmatch = re.search(rf'(?:^|[^a-zA-Z0-9$]){name}\s*=\s*function\s*\([^)]*\)\s*\{{([^}}]+)\}}', js)
        print('body:', fmatch.group(1) if fmatch else None)
