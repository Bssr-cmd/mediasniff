import os
import json
import hashlib
import winreg

def calculate_extension_id(ext_path):
    # Normalize backslashes to forward slashes to match Chrome unpacked ID generation
    normalized_path = ext_path.replace('\\', '/')
    # Calculate SHA256 of the path bytes
    hasher = hashlib.sha256()
    hasher.update(normalized_path.encode('utf-8'))
    hex_digest = hasher.hexdigest()[:32]
    
    # Map hex chars 0-9 to a-j, a-f to k-p
    ext_id = ""
    for char in hex_digest:
        val = int(char, 16)
        ext_id += chr(val + ord('a'))
    return ext_id

def main():
    coapp_dir = os.path.dirname(os.path.abspath(__file__))
    ext_path = os.path.dirname(coapp_dir)
    
    print(f"Companion Directory: {coapp_dir}")
    print(f"Extension Directory: {ext_path}")
    
    # 1. Calculate all possible casing Extension IDs to prevent registry mismatches
    ext_id1 = calculate_extension_id(ext_path)
    ext_id2 = calculate_extension_id(ext_path.lower())
    ext_id3 = calculate_extension_id(ext_path.replace("think", "Think"))
    ext_id4 = calculate_extension_id(ext_path.replace("Users", "users"))
    
    allowed_ids = list(set([ext_id1, ext_id2, ext_id3, ext_id4]))
    print(f"Calculated possible Extension IDs: {allowed_ids}")
    
    # 2. Write Native Messaging Host Manifest
    manifest_path = os.path.join(coapp_dir, "net.mediasniff.coapp.json")
    bat_path = os.path.join(coapp_dir, "coapp.bat")
    
    # Dynamically generate coapp.bat
    try:
        with open(bat_path, 'w', encoding='utf-8') as f:
            f.write(f'@echo off\npython -u "%~dp0coapp.py" %*\n')
        print(f"Successfully generated coapp.bat")
    except Exception as e:
        print(f"Error generating coapp.bat: {e}")
        
    allowed_origins = [f"chrome-extension://{eid}/" for eid in allowed_ids]
    
    manifest_data = {
        "name": "net.mediasniff.coapp",
        "description": "MediaSniff Companion App for native video downloading and remuxing",
        "path": bat_path,
        "type": "stdio",
        "allowed_origins": allowed_origins
    }
    
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest_data, f, indent=2)
    print(f"Wrote Manifest to: {manifest_path}")
    print(f"Manifest data: {json.dumps(manifest_data)}")
    
    # 3. Create Windows Registry Key
    reg_path = r"Software\Google\Chrome\NativeMessagingHosts\net.mediasniff.coapp"
    try:
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path)
        winreg.SetValue(key, "", winreg.REG_SZ, manifest_path)
        winreg.CloseKey(key)
        print("Successfully created Windows Registry entry under HKCU!")
    except Exception as e:
        print(f"Error creating registry entry: {e}")
        
    # 4. Check and install yt-dlp Python package dependency
    print("Checking and installing yt-dlp Python package dependency...")
    try:
        import subprocess
        import sys
        subprocess.run([sys.executable, "-m", "pip", "install", "yt-dlp"], check=True)
        print("yt-dlp dependency successfully satisfied!")
    except Exception as e:
        print(f"WARNING: Failed to automatically install yt-dlp: {e}")

    # 5. Check and download FFmpeg & FFprobe static binaries
    print("Checking and downloading FFmpeg & FFprobe static binaries...")
    try:
        import download_ffmpeg
        download_ffmpeg.download_ffmpeg()
        download_ffmpeg.download_ffprobe()
        print("FFmpeg & FFprobe static binaries checked and satisfied!")
    except Exception as e:
        print(f"WARNING: Failed to automatically download FFmpeg/FFprobe: {e}")

if __name__ == '__main__':
    main()
