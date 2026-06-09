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
    'Cookie': 'VISITOR_INFO1_LIVE=test_cookie; LOGIN_INFO=test_login'
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
    print("Status:", data.get('playabilityStatus', {}).get('status', 'Unknown'))
except Exception as e:
    print("Error", e)
