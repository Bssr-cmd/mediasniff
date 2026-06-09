import urllib.request
import json

client = {
    'clientName': 'TVHTML5',
    'clientVersion': '7.20230405.08.01',
    'clientScreen': 'TV',
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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.142 Safari/537.36; yt.vd=web'
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
    playability = data.get('playabilityStatus', {}).get('status', 'Unknown')
    streamingData = data.get('streamingData', {})
    formats = streamingData.get('formats', [])
    adaptive = streamingData.get('adaptiveFormats', [])
    
    print("Status:", playability)
    print("Total Formats:", len(formats) + len(adaptive))
    if len(adaptive) > 0:
        print("Max Height:", max((f.get('height', 0) for f in adaptive)))
except Exception as e:
    print("Error", e)
