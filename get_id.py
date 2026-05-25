import winreg
import os
import json
def find_coapp_registry():
    print("Scanning HKEY_CURRENT_USER & HKEY_LOCAL_MACHINE for net.downloadhelper.coapp...")
    for hkey in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            key_path = r"Software\Google\Chrome\NativeMessagingHosts\net.downloadhelper.coapp"
            with winreg.OpenKey(hkey, key_path) as key:
                manifest_path, _ = winreg.QueryValue(key, None)
                print(f"Found Registry Entry: {manifest_path}")
                if os.path.exists(manifest_path):
                    with open(manifest_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    app_path = data.get('path')
                    print(f"Companion App executable: {app_path}")
                    app_dir = os.path.dirname(app_path)
                    
                    # Search for ffmpeg in the companion app dir
                    ffmpeg_paths = [
                        os.path.join(app_dir, "ffmpeg.exe"),
                        os.path.join(app_dir, "bin", "ffmpeg.exe"),
                        os.path.join(app_dir, "ffmpeg"),
                    ]
                    for p in ffmpeg_paths:
                        if os.path.exists(p):
                            print(f"FOUND_FFMPEG: {p}")
                            return p
                else:
                    print("Manifest path does not exist on disk.")
        except Exception as e:
            pass
    print("Could not locate net.downloadhelper.coapp in registry.")
    return None
find_coapp_registry()