import urllib.request

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

print("ytInitialPlayerResponse count:", html.count("ytInitialPlayerResponse"))
print("ytInitialData count:", html.count("ytInitialData"))

if "ytInitialPlayerResponse" not in html:
    print("PLAYER_VARS count:", html.count("PLAYER_VARS"))
    print("ytcfg.set count:", html.count("ytcfg.set"))
