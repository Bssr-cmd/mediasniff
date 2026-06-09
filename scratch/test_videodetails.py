import urllib.request
import json

client = {
    'clientName': 'WEB',
    'clientVersion': '2.20260602.06.00',
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
    print("videoDetails present?", 'videoDetails' in data)
except Exception as e:
    print("Error", e)
