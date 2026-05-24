import json
import os
import glob

def scan_preferences(browser_name, base_path):
    print(f"Scanning {browser_name} under {base_path}...")
    pref_files = glob.glob(os.path.join(base_path, '**', 'Preferences'), recursive=True)
    found = False
    for path in pref_files:
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                data = json.load(f)
            extensions = data.get('extensions', {}).get('settings', {})
            for ext_id, ext_data in extensions.items():
                name = ext_data.get('manifest', {}).get('name', '')
                if 'MediaSniff' in name:
                    print(f"  [FOUND] ID: {ext_id}")
                    print(f"  Path: {ext_data.get('path')}")
                    print(f"  Profile Pref: {path}")
                    found = True
        except Exception as e:
            pass
    if not found:
        print(f"  No MediaSniff extension found in {browser_name}.")

def main():
    paths = {
        "Google Chrome": os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\User Data'),
        "Microsoft Edge": os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Edge\User Data'),
        "Brave Browser": os.path.expandvars(r'%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data'),
        "Opera": os.path.expandvars(r'%APPDATA%\Opera Software\Opera Stable'),
    }
    
    for browser, path in paths.items():
        if os.path.exists(path):
            scan_preferences(browser, path)
        else:
            print(f"{browser} User Data path does not exist.")

if __name__ == '__main__':
    main()
