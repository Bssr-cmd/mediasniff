#!/usr/bin/env python3
import sys
import os
import json
import struct
import urllib.request
import subprocess
import tempfile
import shutil
import ssl
import uuid
# Ensure SSL doesn't block downloads due to self-signed certs
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
# Logging helper since we cannot use print() (it would corrupt stdio messaging)
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coapp.log")

def sanitize_for_log(data):
    """Sanitize data before writing to log to ensure cookie values are never leaked."""
    if isinstance(data, dict):
        safe = {}
        for k, v in data.items():
            if k.lower() in ('cookies', 'cookie', 'auth', 'password', 'token'):
                safe[k] = f"<{len(str(v))} bytes redacted>"
            elif isinstance(v, dict):
                safe[k] = sanitize_for_log(v)
            else:
                safe[k] = v
        return safe
    return data

def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{msg}\n")
    except:
        pass
log("--- MediaSniff Companion App Started ---")
def get_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack('@I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)
def send_message(message_content):
    encoded_content = json.dumps(message_content, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('@I', len(encoded_content)))
    sys.stdout.buffer.write(encoded_content)
    sys.stdout.buffer.flush()
def download_file(url, filepath, label, start_pct, end_pct, custom_headers=None, job_id=None):
    log(f"Downloading {label} from {url[:80]}... to {filepath}")
    req_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    if custom_headers and isinstance(custom_headers, dict):
        for hk, hv in custom_headers.items():
            if hk.lower() not in ('cookie', 'cookies'):
                req_headers[hk] = hv
    req = urllib.request.Request(url, headers=req_headers)
    
    with urllib.request.urlopen(req, context=ctx) as response:
        content_length = int(response.headers.get('content-length', 0))
        chunk_size = 1024 * 256
        downloaded = 0
        
        with open(filepath, 'wb') as out_file:
            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                out_file.write(chunk)
                downloaded += len(chunk)
                
                # Report progress
                if content_length > 0:
                    fraction = downloaded / content_length
                    pct = int(start_pct + fraction * (end_pct - start_pct))
                    mb_downloaded = downloaded / (1024 * 1024)
                    mb_total = content_length / (1024 * 1024)
                    msg_out = {
                        "status": "progress",
                        "percent": pct,
                        "statusLabel": f"Downloading {label}: {mb_downloaded:.1f}MB / {mb_total:.1f}MB"
                    }
                    if job_id:
                        msg_out["jobId"] = job_id
                    send_message(msg_out)
def find_ffmpeg():
    # 1. Search in same folder
    local_ffmpeg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg.exe")
    if os.path.exists(local_ffmpeg):
        log(f"Found local FFmpeg: {local_ffmpeg}")
        return local_ffmpeg
    
    # 2. Search in PATH
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        log("Found system PATH FFmpeg")
        return "ffmpeg"
    except:
        pass
        
    return None

def auto_download_ffmpeg():
    log("Auto-downloading FFmpeg static binary dependency...")
    coapp_dir = os.path.dirname(os.path.abspath(__file__))
    output_exe = os.path.join(coapp_dir, "ffmpeg.exe")
    gz_path = os.path.join(coapp_dir, "ffmpeg.gz")
    gz_url = "https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/win32-x64.gz"
    
    try:
        import gzip
        send_message({"status": "progress", "percent": 81, "statusLabel": "Downloading FFmpeg dependency..."})
        req = urllib.request.Request(gz_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=ctx) as response, open(gz_path, 'wb') as out_file:
            out_file.write(response.read())
            
        send_message({"status": "progress", "percent": 83, "statusLabel": "Extracting FFmpeg binary..."})
        with gzip.open(gz_path, 'rb') as f_in, open(output_exe, 'wb') as f_out:
            f_out.write(f_in.read())
            
        log("FFmpeg dependency successfully auto-downloaded!")
        return output_exe
    except Exception as e:
        log(f"Failed to auto-download FFmpeg: {e}")
        return None
    finally:
        if os.path.exists(gz_path):
            try:
                os.remove(gz_path)
            except:
                pass

def find_ytdlp():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    local_ytdlp = os.path.join(base_dir, "yt-dlp.exe" if os.name == 'nt' else "yt-dlp")
    if os.path.exists(local_ytdlp):
        return local_ytdlp
    if shutil.which("yt-dlp"):
        return shutil.which("yt-dlp")
    return None

def auto_download_ytdlp():
    log("Auto-downloading yt-dlp dependency...")
    send_message({"status": "progress", "percent": 5, "statusLabel": "Downloading yt-dlp dependency..."})
    base_dir = os.path.dirname(os.path.abspath(__file__))
    
    if os.name == 'nt':
        url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
        output_exe = os.path.join(base_dir, "yt-dlp.exe")
    else:
        url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
        output_exe = os.path.join(base_dir, "yt-dlp")
        
    try:
        urllib.request.urlretrieve(url, output_exe)
        if os.name != 'nt':
            os.chmod(output_exe, os.stat(output_exe).st_mode | 0o111)
        log("yt-dlp dependency successfully auto-downloaded!")
        return output_exe
    except Exception as e:
        log(f"Failed to auto-download yt-dlp: {e}")
        return None

def handle_ytdlp_download(msg):
    job_id = msg.get("jobId") or msg.get("itemId")
    url = msg.get("url")
    filename = msg.get("filename", "download.mp4")
    cookies = msg.get("cookies")
    headers = msg.get("headers") or {}

    def report(status, percent=None, status_label=None, error=None):
        out = {"status": status}
        if job_id:
            out["jobId"] = job_id
        if percent is not None:
            out["percent"] = percent
        if status_label is not None:
            out["statusLabel"] = status_label
        if error is not None:
            out["error"] = error
        send_message(out)
    
    downloads_dir = os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.exists(downloads_dir):
        downloads_dir = os.getcwd()
        
    output_path = os.path.join(downloads_dir, filename)
    log(f"yt-dlp Output path: {output_path} (jobId: {job_id})")
    
    ytdlp_bin = find_ytdlp()
    if not ytdlp_bin:
        ytdlp_bin = auto_download_ytdlp()
        
    if not ytdlp_bin:
        log("yt-dlp not found and auto-download failed.")
        report("failed", status_label="yt-dlp dependency missing.")
        return
        
    # We also need ffmpeg for yt-dlp to merge formats
    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        ffmpeg_bin = auto_download_ffmpeg()

    report("progress", percent=10, status_label="Starting yt-dlp...")
    cmd = [
        ytdlp_bin,
        "--no-playlist",
        "--socket-timeout", "15",
        "--retries", "2",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", output_path,
        url
    ]
    if ffmpeg_bin:
        cmd.extend(["--ffmpeg-location", os.path.dirname(ffmpeg_bin)])

    # Headers delegation
    if isinstance(headers, dict):
        if headers.get("User-Agent"):
            cmd.extend(["--user-agent", headers["User-Agent"]])
        if headers.get("Referer"):
            cmd.extend(["--referer", headers["Referer"]])

    # Temporary Netscape cookie delegation
    cookie_file = None
    if cookies and isinstance(cookies, str) and cookies.strip():
        try:
            cookie_file = os.path.join(tempfile.gettempdir(), f"ms_cookies_{uuid.uuid4().hex}.txt")
            with open(cookie_file, "w", encoding="utf-8") as f:
                f.write(cookies)
            cmd.extend(["--cookies", cookie_file])
            log(f"Injected temporary cookie jar ({len(cookies)} bytes) for jobId: {job_id}")
        except Exception as ce:
            log(f"Failed to create temporary cookie file: {ce}")

    active_processes = getattr(handle_ytdlp_download, "active_processes", None)
    if active_processes is None:
        active_processes = {}
        handle_ytdlp_download.active_processes = active_processes

    log(f"Executing: {' '.join(cmd)}")
    try:
        # Run yt-dlp and capture output for progress
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, universal_newlines=True)
        if job_id:
            active_processes[job_id] = process
        import re
        progress_pattern = re.compile(r'\[download\]\s+([0-9.]+)%')
        
        for line in process.stdout:
            match = progress_pattern.search(line)
            if match:
                try:
                    pct = float(match.group(1))
                    overall = int(10 + pct * 0.85) # scale from 10% to 95%
                    report("progress", percent=overall, status_label=f"yt-dlp downloading: {pct}%")
                except:
                    pass
        
        process.wait()
        if process.returncode == 0:
            log(f"yt-dlp download completed successfully! (jobId: {job_id})")
            report("complete", status_label=f"Saved to Downloads: {filename}")
        else:
            log(f"yt-dlp failed with exit code {process.returncode} (jobId: {job_id})")
            report("failed", status_label=f"yt-dlp failed (Code {process.returncode})")
            
    except Exception as e:
        log(f"yt-dlp task error: {e} (jobId: {job_id})")
        report("failed", status_label=f"yt-dlp Error: {str(e)}")
    finally:
        if job_id and hasattr(handle_ytdlp_download, "active_processes"):
            handle_ytdlp_download.active_processes.pop(job_id, None)
        # Secure cleanup: delete temporary cookie file immediately upon completion/failure
        if cookie_file and os.path.exists(cookie_file):
            try:
                os.remove(cookie_file)
                log(f"Cleaned up temporary cookie jar for jobId: {job_id}")
            except Exception as d_err:
                log(f"Warning: Failed to remove temp cookie file: {d_err}")

def handle_download_and_mux(msg):
    job_id = msg.get("jobId") or msg.get("itemId")
    video_url = msg.get("videoUrl")
    audio_url = msg.get("audioUrl")
    filename = msg.get("filename", "download.mp4")
    headers = msg.get("headers") or {}

    def report(status, percent=None, status_label=None, error=None):
        out = {"status": status}
        if job_id:
            out["jobId"] = job_id
        if percent is not None:
            out["percent"] = percent
        if status_label is not None:
            out["statusLabel"] = status_label
        if error is not None:
            out["error"] = error
        send_message(out)
    
    # Resolve standard Windows Downloads folder
    downloads_dir = os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.exists(downloads_dir):
        downloads_dir = os.getcwd()
        
    output_path = os.path.join(downloads_dir, filename)
    log(f"Output path resolved: {output_path} (jobId: {job_id})")
    
    uid = uuid.uuid4().hex
    temp_video = os.path.join(tempfile.gettempdir(), f"ms_temp_video_{uid}.mp4")
    temp_audio = os.path.join(tempfile.gettempdir(), f"ms_temp_audio_{uid}.m4a")
    
    try:
        # 1. Download video
        download_file(video_url, temp_video, "video", 5, 50, custom_headers=headers, job_id=job_id)
        
        # 2. Download audio if present
        if audio_url:
            try:
                download_file(audio_url, temp_audio, "audio", 50, 80, custom_headers=headers, job_id=job_id)
            except Exception as audio_err:
                log(f"Audio download failed, falling back to video only: {audio_err}")
                audio_url = None
        
        # 3. Locate FFmpeg
        ffmpeg_bin = find_ffmpeg()
        if not ffmpeg_bin:
            ffmpeg_bin = auto_download_ffmpeg()
            
        if not ffmpeg_bin:
            log("FFmpeg not found and auto-download failed! Falling back to raw video copying.")
            # If no FFmpeg and no audio, copy video to destination
            if not audio_url:
                os.replace(temp_video, output_path)
                report("complete", status_label=f"Saved: {filename}")
                return
            else:
                raise Exception("FFmpeg not found on host system and auto-download failed. Merging requires FFmpeg.")
                
        # 4. Mux tracks losslessly using FFmpeg
        report("progress", percent=85, status_label="Muxing tracks natively (FFmpeg)...")
        
        cmd = [ffmpeg_bin]
        if audio_url:
            cmd += ["-i", temp_video, "-i", temp_audio, "-c", "copy", "-y", output_path]
        else:
            cmd += ["-i", temp_video, "-c", "copy", "-y", output_path]
            
        log(f"Executing: {' '.join(cmd)}")
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        
        if result.returncode != 0:
            log(f"FFmpeg copy failed: {result.stderr}. Retrying with auto-encoding...")
            # Fallback: copy video losslessly, transcode audio to highly compatible aac
            cmd_fallback = [ffmpeg_bin]
            if audio_url:
                cmd_fallback += ["-i", temp_video, "-i", temp_audio, "-c:v", "copy", "-c:a", "aac", "-strict", "experimental", "-y", output_path]
            else:
                cmd_fallback += ["-i", temp_video, "-c:v", "copy", "-y", output_path]
                
            log(f"Executing fallback: {' '.join(cmd_fallback)}")
            result = subprocess.run(cmd_fallback, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            
            if result.returncode != 0:
                log(f"FFmpeg failed with exit code {result.returncode}. Error: {result.stderr}")
                raise Exception(f"FFmpeg muxing failed: {result.stderr[:100]}")
            
        log(f"Lossless muxing completed successfully! (jobId: {job_id})")
        report("complete", status_label=f"Saved to Downloads: {filename}")
        
    except Exception as e:
        log(f"Download/Mux task error: {e} (jobId: {job_id})")
        report("failed", status_label=f"Host Error: {str(e)}", error=str(e))
        
    finally:
        # Clean up temp files
        for f in (temp_video, temp_audio):
            if os.path.exists(f):
                try:
                    os.remove(f)
                except:
                    pass

def main():
    while True:
        try:
            msg = get_message()
            if msg is None:
                log("Stdin closed, exiting host.")
                break
                
            log(f"Received message: {json.dumps(sanitize_for_log(msg))}")
            action = msg.get("action")
            job_id = msg.get("jobId") or msg.get("itemId")
            
            if action == "ping":
                resp = {"status": "pong"}
                if job_id:
                    resp["jobId"] = job_id
                send_message(resp)
            elif action == "ytdlp_download":
                handle_ytdlp_download(msg)
            elif action == "download_and_mux":
                handle_download_and_mux(msg)
            elif action == "cancel":
                target_job = msg.get("jobId") or msg.get("itemId")
                procs = getattr(handle_ytdlp_download, "active_processes", {})
                if target_job and target_job in procs:
                    try:
                        procs[target_job].terminate()
                        log(f"Terminated process for cancelled job: {target_job}")
                    except Exception as te:
                        log(f"Error terminating job {target_job}: {te}")
                resp = {"status": "cancelled", "statusLabel": "Job cancelled"}
                if target_job:
                    resp["jobId"] = target_job
                send_message(resp)
            else:
                resp = {"status": "failed", "statusLabel": "Unknown action: " + str(action)}
                if job_id:
                    resp["jobId"] = job_id
                send_message(resp)
                
        except Exception as e:
            log(f"Main loop error: {e}")
            break

if __name__ == '__main__':
    main()
