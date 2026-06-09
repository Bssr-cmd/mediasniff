import urllib.request
import json

client = {
    'clientName': 'IOS',
    'clientVersion': '20.21.6',
    'deviceMake': 'Apple',
    'deviceModel': 'iPhone16,2',
    'osName': 'iPhone',
    'osVersion': '18.5.0.22F76',
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

headers = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': '5',
    'X-YouTube-Client-Version': client['clientVersion'],
    'User-Agent': 'Mozilla/5.0'
}

req = urllib.request.Request(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    data=json.dumps(body).encode('utf-8'),
    headers=headers,
    method='POST'
)

try:
    response = urllib.request.urlopen(req)
    data = json.loads(response.read())
    streamingData = data.get('streamingData', {})
    formats = streamingData.get('formats', [])
    adaptive = streamingData.get('adaptiveFormats', [])
    
    print("--- IOS Formats ---")
    for f in adaptive:
        print(f"Adaptive: itag={f.get('itag')}, url={'YES' if 'url' in f else 'NO'}")
except Exception as e:
    print("Error", e)
