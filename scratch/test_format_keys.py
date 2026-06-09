import urllib.request
import json
import re

url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw&bpctr=9999999999&has_verified=1'
req = urllib.request.Request(
    url,
    headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    }
)

html = urllib.request.urlopen(req).read().decode('utf-8')

match = re.search(r'ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var\s|script|)', html)
if match:
    data = json.loads(match.group(1))
    streamingData = data.get('streamingData', {})
    adaptive = streamingData.get('adaptiveFormats', [])
    
    print(json.dumps(adaptive[0], indent=2))
