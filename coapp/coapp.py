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
import re
import threading

# Windows binary stdio configuration to prevent newline translation corruption
if sys.platform == "win32":
    import msvcrt
    try:
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except Exception:
        pass

# Windows flag to suppress console window flashing for child processes
CREATE_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# Ensure SSL doesn't block downloads due to self-signed certs or enterprise MITM proxies
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
    except Exception:
        pass

log("--- MediaSniff Companion App Started ---")

# Thread safety locks and state tracking
send_lock = threading.Lock()
ACTIVE_PROCESSES = {}
ACTIVE_PROCESSES_LOCK = threading.Lock()
CANCELLED_JOBS = set()
CANCELLED_JOBS_LOCK = threading.Lock()

def register_process(job_id, proc):
    if not job_id:
        return
    with ACTIVE_PROCESSES_LOCK:
        ACTIVE_PROCESSES[job_id] = proc

def unregister_process(job_id):
    if not job_id:
        return
    with ACTIVE_PROCESSES_LOCK:
        ACTIVE_PROCESSES.pop(job_id, None)

def cancel_job(job_id):
    if not job_id:
        return
    with CANCELLED_JOBS_LOCK:
        CANCELLED_JOBS.add(job_id)
    with ACTIVE_PROCESSES_LOCK:
        proc = ACTIVE_PROCESSES.get(job_id)
    if proc:
        kill_process(proc)

def is_job_cancelled(job_id):
    if not job_id:
        return False
    with CANCELLED_JOBS_LOCK:
        return job_id in CANCELLED_JOBS

def kill_process(proc):
    if not proc:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW
            )
        else:
            proc.terminate()
    except Exception as e:
        log(f"Error terminating process tree: {e}")
        try:
            proc.kill()
        except Exception:
            pass

def sanitize_filename(filename, default="download.mp4"):
    """Sanitize filename to prevent directory traversal and Windows-illegal characters."""
    if not filename or not isinstance(filename, str):
        return default
    # Strip directory components
    filename = os.path.basename(filename)
    # Replace forbidden Windows characters: < > : " / \ | ? *
    filename = re.sub(r'[<>:"/\\|?*]', '_', filename)
    # Strip trailing periods and spaces (forbidden by Windows filesystem)
    filename = filename.strip('. ')
    return filename or default

def get_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    message_length = struct.unpack('@I', raw_length)[0]
    raw_data = bytearray()
    while len(raw_data) < message_length:
        chunk = sys.stdin.buffer.read(message_length - len(raw_data))
        if not chunk:
            return None
        raw_data.extend(chunk)
    return json.loads(raw_data.decode('utf-8'))

def send_message(message_content):
    encoded_content = json.dumps(message_content, separators=(',', ':')).encode('utf-8')
    with send_lock:
        sys.stdout.buffer.write(struct.pack('@I', len(encoded_content)))
        sys.stdout.buffer.write(encoded_content)
        sys.stdout.buffer.flush()

def download_file(url, filepath, label, start_pct, end_pct, custom_headers=None, job_id=None):
    log(f"Downloading {label} from {url[:80]}... to {filepath}")
    req_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    if custom_headers and isinstance(custom_headers, dict):
        for hk, hv in custom_headers.items():
            req_headers[hk] = hv
    req = urllib.request.Request(url, headers=req_headers)
    
    with urllib.request.urlopen(req, context=ctx) as response:
        try:
            content_length = int(response.headers.get('content-length', 0))
        except (ValueError, TypeError):
            content_length = 0
            
        chunk_size = 1024 * 256
        downloaded = 0
        
        with open(filepath, 'wb') as out_file:
            while True:
                if job_id and is_job_cancelled(job_id):
                    raise Exception("Job cancelled by user")
                    
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                out_file.write(chunk)
                downloaded += len(chunk)
                
                # Report progress
                mb_downloaded = downloaded / (1024 * 1024)
                if content_length > 0:
                    fraction = downloaded / content_length
                    pct = int(start_pct + fraction * (end_pct - start_pct))
                    mb_total = content_length / (1024 * 1024)
                    status_lbl = f"Downloading {label}: {mb_downloaded:.1f}MB / {mb_total:.1f}MB"
                else:
                    pct = start_pct
                    status_lbl = f"Downloading {label}: {mb_downloaded:.1f}MB"
                    
                msg_out = {
                    "status": "progress",
                    "percent": pct,
                    "statusLabel": status_lbl
                }
                if job_id:
                    msg_out["jobId"] = job_id
                send_message(msg_out)

def find_ffmpeg():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    local_ffmpeg = os.path.join(base_dir, "ffmpeg.exe" if os.name == 'nt' else "ffmpeg")
    if os.path.exists(local_ffmpeg) and os.path.getsize(local_ffmpeg) > 1000:
        log(f"Found local FFmpeg: {local_ffmpeg}")
        return local_ffmpeg
    
    found = shutil.which("ffmpeg")
    if found:
        log(f"Found system PATH FFmpeg: {found}")
        return found
        
    return None

def auto_download_ffmpeg(job_id=None):
    log("Auto-downloading FFmpeg static binary dependency...")
    coapp_dir = os.path.dirname(os.path.abspath(__file__))
    output_exe = os.path.join(coapp_dir, "ffmpeg.exe")
    gz_path = os.path.join(coapp_dir, "ffmpeg.gz")
    gz_url = "https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/win32-x64.gz"
    
    try:
        import gzip
        msg_dl = {"status": "progress", "percent": 81, "statusLabel": "Downloading FFmpeg dependency..."}
        if job_id:
            msg_dl["jobId"] = job_id
        send_message(msg_dl)
        
        req = urllib.request.Request(gz_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=ctx) as response, open(gz_path, 'wb') as out_file:
            shutil.copyfileobj(response, out_file)
            
        msg_ex = {"status": "progress", "percent": 83, "statusLabel": "Extracting FFmpeg binary..."}
        if job_id:
            msg_ex["jobId"] = job_id
        send_message(msg_ex)
        
        with gzip.open(gz_path, 'rb') as f_in, open(output_exe, 'wb') as f_out:
            shutil.copyfileobj(f_in, f_out)
            
        log("FFmpeg dependency successfully auto-downloaded!")
        return output_exe
    except Exception as e:
        log(f"Failed to auto-download FFmpeg: {e}")
        if os.path.exists(output_exe):
            try:
                os.remove(output_exe)
            except Exception:
                pass
        return None
    finally:
        if os.path.exists(gz_path):
            try:
                os.remove(gz_path)
            except Exception:
                pass

def find_ytdlp():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    local_ytdlp = os.path.join(base_dir, "yt-dlp.exe" if os.name == 'nt' else "yt-dlp")
    if os.path.exists(local_ytdlp) and os.path.getsize(local_ytdlp) > 1000:
        return local_ytdlp
    if shutil.which("yt-dlp"):
        return shutil.which("yt-dlp")
    return None

def auto_download_ytdlp(job_id=None):
    log("Auto-downloading yt-dlp dependency...")
    msg_dl = {"status": "progress", "percent": 5, "statusLabel": "Downloading yt-dlp dependency..."}
    if job_id:
        msg_dl["jobId"] = job_id
    send_message(msg_dl)
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    if os.name == 'nt':
        url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
        output_exe = os.path.join(base_dir, "yt-dlp.exe")
    else:
        url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
        output_exe = os.path.join(base_dir, "yt-dlp")
        
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, context=ctx) as response, open(output_exe, 'wb') as out_file:
            shutil.copyfileobj(response, out_file)
        if os.name != 'nt':
            os.chmod(output_exe, os.stat(output_exe).st_mode | 0o111)
        log("yt-dlp dependency successfully auto-downloaded!")
        return output_exe
    except Exception as e:
        log(f"Failed to auto-download yt-dlp: {e}")
        if os.path.exists(output_exe):
            try:
                os.remove(output_exe)
            except Exception:
                pass
        return None

def handle_ytdlp_download(msg):
    job_id = msg.get("jobId") or msg.get("itemId")
    url = msg.get("url")
    raw_filename = msg.get("filename", "download.mp4")
    filename = sanitize_filename(raw_filename)
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
    
    if not url:
        report("failed", status_label="Missing download URL", error="url is required")
        return
        
    with CANCELLED_JOBS_LOCK:
        CANCELLED_JOBS.discard(job_id)

    downloads_dir = os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.exists(downloads_dir):
        downloads_dir = os.getcwd()
        
    output_path = os.path.join(downloads_dir, filename)
    log(f"yt-dlp Output path: {output_path} (jobId: {job_id})")
    
    ytdlp_bin = find_ytdlp()
    if not ytdlp_bin:
        ytdlp_bin = auto_download_ytdlp(job_id=job_id)
        
    if not ytdlp_bin:
        log("yt-dlp not found and auto-download failed.")
        report("failed", status_label="yt-dlp dependency missing.", error="yt-dlp dependency missing.")
        return
        
    # We also need ffmpeg for yt-dlp to merge formats
    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        ffmpeg_bin = auto_download_ffmpeg(job_id=job_id)

    quality = msg.get("quality") or msg.get("ytQuality")
    if quality:
        q_match = re.search(r'\d+', str(quality))
        if q_match:
            qh = int(q_match.group(0))
            format_spec = f"bestvideo[height<={qh}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={qh}]+bestaudio/best[height<={qh}]/best"
        else:
            format_spec = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best"
    else:
        format_spec = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best"

    report("progress", percent=10, status_label="Starting yt-dlp...")
    cmd = [
        ytdlp_bin,
        "--no-playlist",
        "--newline",
        "--socket-timeout", "15",
        "--retries", "2",
        "-f", format_spec,
        "--merge-output-format", "mp4",
        "-o", output_path
    ]
    if sys.platform == 'win32':
        cmd.append("--windows-filenames")

    if ffmpeg_bin:
        ffmpeg_dir = os.path.dirname(ffmpeg_bin) if os.path.isabs(ffmpeg_bin) else None
        if ffmpeg_dir:
            cmd.extend(["--ffmpeg-location", ffmpeg_dir])
        elif os.path.isabs(ffmpeg_bin):
            cmd.extend(["--ffmpeg-location", ffmpeg_bin])

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

    cmd.append(url)
    log(f"Executing: {' '.join(cmd)}")
    
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
            encoding='utf-8',
            errors='replace',
            creationflags=CREATE_NO_WINDOW
        )
        register_process(job_id, process)
        
        progress_pattern = re.compile(r'\[download\]\s+([0-9.]+)%')
        last_output_lines = []
        
        for line in process.stdout:
            clean_line = line.strip()
            if clean_line:
                last_output_lines.append(clean_line)
                if len(last_output_lines) > 10:
                    last_output_lines.pop(0)
                    
            match = progress_pattern.search(line)
            if match:
                try:
                    pct = float(match.group(1))
                    overall = int(10 + pct * 0.85) # scale from 10% to 95%
                    report("progress", percent=overall, status_label=f"yt-dlp downloading: {pct}%")
                except Exception:
                    pass
        
        process.wait()
        
        if is_job_cancelled(job_id):
            log(f"yt-dlp job {job_id} was cancelled, suppressing exit report.")
            return
            
        if process.returncode == 0:
            log(f"yt-dlp download completed successfully! (jobId: {job_id})")
            report("complete", status_label=f"Saved to Downloads: {filename}")
        else:
            error_detail = next((l for l in reversed(last_output_lines) if "ERROR" in l.upper()), None)
            if not error_detail and last_output_lines:
                error_detail = last_output_lines[-1]
            error_msg = error_detail or f"yt-dlp exit code {process.returncode}"
            log(f"yt-dlp failed with exit code {process.returncode} (jobId: {job_id}): {error_msg}")
            report("failed", status_label=f"yt-dlp failed: {error_msg}", error=error_msg)
            
    except Exception as e:
        if is_job_cancelled(job_id):
            log(f"yt-dlp job {job_id} cancelled during exception: {e}")
            return
        log(f"yt-dlp task error: {e} (jobId: {job_id})")
        report("failed", status_label=f"yt-dlp Error: {str(e)}", error=str(e))
    finally:
        unregister_process(job_id)
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
    raw_filename = msg.get("filename", "download.mp4")
    filename = sanitize_filename(raw_filename)
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
    
    if not video_url:
        report("failed", status_label="Missing video URL", error="videoUrl is required")
        return
        
    with CANCELLED_JOBS_LOCK:
        CANCELLED_JOBS.discard(job_id)

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
                if is_job_cancelled(job_id):
                    return
                log(f"Audio download failed: {audio_err}")
                raise Exception(f"Audio download failed: {audio_err}")
        
        if is_job_cancelled(job_id):
            return
            
        # 3. Locate FFmpeg
        ffmpeg_bin = find_ffmpeg()
        if not ffmpeg_bin:
            ffmpeg_bin = auto_download_ffmpeg(job_id=job_id)
            
        if not ffmpeg_bin:
            log("FFmpeg not found and auto-download failed! Falling back to raw video copying.")
            if not audio_url:
                shutil.move(temp_video, output_path)
                report("complete", status_label=f"Saved: {filename}")
                return
            else:
                raise Exception("FFmpeg not found on host system and auto-download failed. Merging requires FFmpeg.")
                
        # 4. Mux tracks natively using FFmpeg
        report("progress", percent=85, status_label="Muxing tracks natively (FFmpeg)...")
        
        cmd = [ffmpeg_bin]
        if audio_url:
            cmd += ["-i", temp_video, "-i", temp_audio, "-c", "copy", "-y", output_path]
        else:
            cmd += ["-i", temp_video, "-c", "copy", "-y", output_path]
            
        log(f"Executing: {' '.join(cmd)}")
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            creationflags=CREATE_NO_WINDOW
        )
        register_process(job_id, proc)
        stdout, stderr = proc.communicate()
        unregister_process(job_id)
        
        if is_job_cancelled(job_id):
            log(f"Download/Mux job {job_id} cancelled during FFmpeg muxing.")
            return
            
        if proc.returncode != 0:
            log(f"FFmpeg copy failed: {stderr}. Retrying with auto-encoding...")
            # Fallback: copy video, transcode audio to aac
            cmd_fallback = [ffmpeg_bin]
            if audio_url:
                cmd_fallback += ["-i", temp_video, "-i", temp_audio, "-c:v", "copy", "-c:a", "aac", "-strict", "experimental", "-y", output_path]
            else:
                cmd_fallback += ["-i", temp_video, "-c:v", "copy", "-y", output_path]
                
            log(f"Executing fallback: {' '.join(cmd_fallback)}")
            proc_fallback = subprocess.Popen(
                cmd_fallback,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding='utf-8',
                errors='replace',
                creationflags=CREATE_NO_WINDOW
            )
            register_process(job_id, proc_fallback)
            stdout, stderr = proc_fallback.communicate()
            unregister_process(job_id)
            
            if is_job_cancelled(job_id):
                return
                
            if proc_fallback.returncode != 0:
                log(f"FFmpeg failed with exit code {proc_fallback.returncode}. Error: {stderr}")
                err_snippet = (stderr or "").strip().splitlines()[-1] if stderr else f"Exit code {proc_fallback.returncode}"
                raise Exception(f"FFmpeg muxing failed: {err_snippet}")
            
        log(f"Lossless muxing completed successfully! (jobId: {job_id})")
        report("complete", status_label=f"Saved to Downloads: {filename}")
        
    except Exception as e:
        if is_job_cancelled(job_id):
            log(f"Download/Mux job {job_id} was cancelled, suppressing failure report.")
            return
        log(f"Download/Mux task error: {e} (jobId: {job_id})")
        report("failed", status_label=f"Host Error: {str(e)}", error=str(e))
        
    finally:
        unregister_process(job_id)
        # Clean up temp files
        for f in (temp_video, temp_audio):
            if os.path.exists(f):
                try:
                    os.remove(f)
                except Exception:
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
                t = threading.Thread(target=handle_ytdlp_download, args=(msg,), daemon=True)
                t.start()
            elif action == "download_and_mux":
                t = threading.Thread(target=handle_download_and_mux, args=(msg,), daemon=True)
                t.start()
            elif action == "cancel":
                target_job = msg.get("jobId") or msg.get("itemId")
                log(f"Processing cancel request for jobId: {target_job}")
                if target_job:
                    cancel_job(target_job)
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

    # Clean up all active child processes on exit
    with ACTIVE_PROCESSES_LOCK:
        for jid, p in list(ACTIVE_PROCESSES.items()):
            try:
                kill_process(p)
            except Exception:
                pass

if __name__ == '__main__':
    main()
