import urllib.request
import json
import re

client = {
    'clientName': 'WEB',
    'clientVersion': '2.20260602.06.00',
    'hl': 'en',
    'gl': 'US',
}

videoId = 'dQw4w9WgXcQ' # Rick Astley

body = {
    'videoId': videoId,
    'context': { 'client': client },
}

req = urllib.request.Request(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    data=json.dumps(body).encode('utf-8'),
    headers={'Content-Type': 'application/json'}
)

try:
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read().decode('utf-8'))
    
    with open('rick_astley.json', 'w') as f:
        json.dump(data, f, indent=2)
        
    print("Playability:", data.get('playabilityStatus', {}).get('status'))
    streamingData = data.get('streamingData', {})
    
    adaptive = streamingData.get('adaptiveFormats', [])
    formats = streamingData.get('formats', [])
    
    print(f"Adaptive formats: {len(adaptive)}")
    for f in adaptive[:5]:
        print(f"  - {f.get('mimeType')} | url: {'YES' if f.get('url') else 'NO'} | cipher: {'YES' if f.get('signatureCipher') else 'NO'}")
        
except Exception as e:
    print("Error:", e)
