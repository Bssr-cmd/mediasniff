import subprocess
import struct
import json
import os

def main():
    coapp_dir = "c:\\Users\\think\\.gemini\\antigravity\\scratch\\mediasniff\\coapp"
    bat_path = os.path.join(coapp_dir, "coapp.bat")
    
    print(f"Launching {bat_path}...")
    
    # Start the coapp process
    p = subprocess.Popen(
        [bat_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    
    # Prepare native messaging length-prefixed ping message
    msg = {"action": "ping"}
    msg_bytes = json.dumps(msg).encode('utf-8')
    length_bytes = struct.pack('@I', len(msg_bytes))
    
    print("Sending ping message...")
    p.stdin.write(length_bytes)
    p.stdin.write(msg_bytes)
    p.stdin.flush()
    
    # Read response length
    print("Waiting for response length...")
    res_len_bytes = p.stdout.read(4)
    if not res_len_bytes:
        print("Failed to read response length. Stderr:")
        print(p.stderr.read().decode('utf-8', errors='replace'))
        p.terminate()
        return
        
    res_len = struct.unpack('@I', res_len_bytes)[0]
    print(f"Response length: {res_len} bytes")
    
    # Read response message
    res_bytes = p.stdout.read(res_len)
    res = json.loads(res_bytes.decode('utf-8'))
    print(f"Received response: {res}")
    
    p.terminate()

if __name__ == '__main__':
    main()
