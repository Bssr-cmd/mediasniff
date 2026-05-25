import os
import json
import hashlib
import winreg
def calculate_extension_id(path):
    # Calculate SHA256 of the path bytes exactly as passed
    hasher = hashlib.sha256()
    hasher.update(path.encode('utf-8'))
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
    
    # Generate path variations to hash
    drive = ext_path[:2]
    rest = ext_path[2:]
    
    paths_to_hash = [
        ext_path,
        drive.lower() + rest,
        drive.upper() + rest,
        ext_path.replace('\\', '/'),
        drive.lower() + rest.replace('\\', '/'),
        drive.upper() + rest.replace('\\', '/'),
        ext_path.replace('/', '\\'),
        drive.lower() + rest.replace('/', '\\'),
        drive.upper() + rest.replace('/', '\\'),
    ]
    
    unique_ids = set()
    for p in paths_to_hash:
        eid = calculate_extension_id(p)
        unique_ids.add(eid)
        print(f"  Path variation: {p} -> {eid}")
        
    # Write Native Messaging Host Manifest
    manifest_path = os.path.join(coapp_dir, "net.mediasniff.coapp.json")
    bat_path = os.path.join(coapp_dir, "coapp.bat")
    
    allowed_origins = [f"chrome-extension://{eid}/" for eid in sorted(list(unique_ids))]
    
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
if __name__ == '__main__':
    main()
