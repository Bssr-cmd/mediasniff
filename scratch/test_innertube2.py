import urllib.request
import json

clients = [
    {
        'clientName': 'IOS',
        'clientVersion': '20.21.6',
        'deviceMake': 'Apple',
        'deviceModel': 'iPhone16,2',
        'osName': 'iPhone',
        'osVersion': '18.5.0.22F76',
        'hl': 'en',
        'gl': 'US',
    },
    {
        'clientName': 'ANDROID',
        'clientVersion': '20.21.38',
        'androidSdkVersion': 34,
        'osName': 'Android',
        'osVersion': '14',
        'hl': 'en',
        'gl': 'US',
    },
]

videoId = 'jNQXAC9IVRw' # Me at the zoo

for client in clients:
    try:
        body = {
            'videoId': videoId,
            'context': {
                'client': client
            },
            'playbackContext': {
                'contentPlaybackContext': { 'signatureTimestamp': 0 }
            },
            'contentCheckOk': True,
            'racyCheckOk': True,
        }
        
        headers = {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '5' if client['clientName'] == 'IOS' else '3' if client['clientName'] == 'ANDROID' else '1',
            'X-YouTube-Client-Version': client['clientVersion'],
        }
        
        if client['clientName'] == 'IOS':
            headers['User-Agent'] = 'com.google.ios.youtube/20.21.6 (iPhone16,2; U; CPU iOS 18_5_0 like Mac OS X;)'
        elif client['clientName'] == 'ANDROID':
            headers['User-Agent'] = 'com.google.android.youtube/20.21.38 (Linux; U; Android 14) gzip'
        
        req = urllib.request.Request(
            'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
            data=json.dumps(body).encode('utf-8'),
            headers=headers,
            method='POST'
        )
        
        response = urllib.request.urlopen(req)
        data = json.loads(response.read())
        
        playability = data.get('playabilityStatus', {}).get('status', 'Unknown')
        streamingData = data.get('streamingData', {})
        formats = streamingData.get('formats', [])
        adaptive = streamingData.get('adaptiveFormats', [])
        all_formats = formats + adaptive
        
        has_direct = any('url' in f and 'signatureCipher' not in f and 'cipher' not in f for f in all_formats)
        has_cipher = any('signatureCipher' in f or 'cipher' in f for f in all_formats)
        
        print(f"[{client['clientName']}] Status: {playability}, Total Formats: {len(all_formats)}, Has Direct: {has_direct}, Has Cipher: {has_cipher}")
        
    except Exception as e:
        print(f"[{client['clientName']}] Failed: {str(e)}")
