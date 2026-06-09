import urllib.request
import json

client = {
    'clientName': 'ANDROID',
    'clientVersion': '20.21.38',
    'androidSdkVersion': 34,
    'osName': 'Android',
    'osVersion': '14',
    'hl': 'en',
    'gl': 'US',
}

videoId = 'jNQXAC9IVRw'

body = {
    'videoId': videoId,
    'context': { 'client': client },
    'playbackContext': {
        'contentPlaybackContext': { 'signatureTimestamp': 0 }
    },
    'contentCheckOk': True,
    'racyCheckOk': True,
}

# Emulate browser's fetch where User-Agent CANNOT be overridden
headers = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': '3',
    'X-YouTube-Client-Version': client['clientVersion'],
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

req = urllib.request.Request(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    data=json.dumps(body).encode('utf-8'),
    headers=headers,
    method='POST'
)

response = urllib.request.urlopen(req)
data = json.loads(response.read())

streamingData = data.get('streamingData', {})
formats = streamingData.get('formats', [])
adaptive = streamingData.get('adaptiveFormats', [])

print("--- Formats ---")
for f in formats:
    print(f"Format: itag={f.get('itag')}, url={'YES' if 'url' in f else 'NO'}")

print("--- Adaptive Formats ---")
for f in adaptive:
    print(f"Adaptive: itag={f.get('itag')}, url={'YES' if 'url' in f else 'NO'}")
