import urllib.request
import gzip
import os
import ssl
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
def download_ffmpeg():
    coapp_dir = os.path.dirname(os.path.abspath(__file__))
    output_exe = os.path.join(coapp_dir, "ffmpeg.exe")
    
    if os.path.exists(output_exe):
        print("ffmpeg.exe is already present.")
        return
        
    gz_url = "https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/win32-x64.gz"
    gz_path = os.path.join(coapp_dir, "ffmpeg.gz")
    
    print(f"Downloading compact FFmpeg static binary from: {gz_url}")
    print("This is a 20MB download and will extract to a standalone ffmpeg.exe...")
    
    try:
        # Download gzipped binary
        req = urllib.request.Request(
            gz_url,
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req, context=ctx) as response, open(gz_path, 'wb') as out_file:
            data = response.read()
            out_file.write(data)
            
        print("Download complete. Decompressing ffmpeg.gz to ffmpeg.exe...")
        # Decompress gzip
        with gzip.open(gz_path, 'rb') as f_in, open(output_exe, 'wb') as f_out:
            f_out.write(f_in.read())
            
        print("Success! ffmpeg.exe has been extracted successfully.")
    except Exception as e:
        print(f"Error downloading FFmpeg: {e}")
    finally:
        # Clean up gz temp file
        if os.path.exists(gz_path):
            try:
                os.remove(gz_path)
            except:
                pass
if __name__ == '__main__':
    download_ffmpeg()
