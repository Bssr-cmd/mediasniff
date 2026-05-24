#!/usr/bin/env python3
import sys
import os
import json
import struct
import urllib.request
import urllib.parse
import subprocess
import tempfile
import ssl
import time

# Ensure SSL doesn't block downloads due to self-signed certs
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Logging helper since we cannot use print() (it would corrupt stdio messaging)
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coapp.log")

def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
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

def strip_range_param(url):
    try:
        import re
        # Remove range= and rn= parameters safely without reordering query string
        url = re.sub(r'([?&])(range|rn|rbuf)=[^&]*', '', url)
        url = url.replace('?&', '?').rstrip('&')
        return url
    except Exception as e:
        log(f"Error stripping range param: {e}")
        return url

def filter_headers(custom_headers):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com/'
    }
    if not custom_headers:
        return headers
        
    IGNORE_HEADERS = {'accept-encoding', 'content-length', 'range', 'connection', 'host'}
    for k, v in custom_headers.items():
        if k.lower() not in IGNORE_HEADERS:
            headers[k] = v
    return headers

def get_stream_info(url, custom_headers=None):
    headers = filter_headers(custom_headers)
    clean_url = strip_range_param(url)
    req_headers = headers.copy()
    req_headers['Range'] = "bytes=0-100"
    
    req = urllib.request.Request(clean_url, headers=req_headers)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as response:
            mime = response.headers.get('Content-Type', '').lower()
            content_range = response.headers.get('Content-Range')
            total_size = 0
            if content_range:
                # bytes 0-100/total_size
                total_size = int(content_range.split('/')[-1])
            else:
                total_size = int(response.headers.get('content-length', 0))
            return mime, total_size
    except Exception as e:
        log(f"Error getting stream info: {e}")
        return None, 0

def download_chunked(url, filepath, label, start_pct, end_pct, expected_size, custom_headers=None):
    log(f"Starting robust chunked DASH range download for {label} to {filepath}")
    
    # Strip the range parameter from the query string to prevent CDN signature invalidation
    clean_url = strip_range_param(url)
    log(f"Cleaned stream URL: {clean_url[:120]}...")
    
    headers = filter_headers(custom_headers)

    total_size = expected_size
    if total_size <= 0:
        mime, total_size = get_stream_info(clean_url, custom_headers)
        if total_size <= 0:
            log(f"Could not resolve total size for {label}. Falling back to standard direct download.")
            download_file_direct(clean_url, filepath, label, start_pct, end_pct, custom_headers)
            return

    log(f"Total size resolved: {total_size} bytes ({total_size / (1024*1024):.2f} MB)")
    
    # 3MB chunk sizes are highly stable and prevent CDN connection drops or timeouts
    chunk_size = 3 * 1024 * 1024
    downloaded = 0
    
    with open(filepath, 'wb') as out_file:
        while downloaded < total_size:
            start = downloaded
            end = min(downloaded + chunk_size - 1, total_size - 1)
            
            # Request byte segment using standard HTTP Range Header
            req_headers = headers.copy()
            req_headers['Range'] = f"bytes={start}-{end}"
            
            req = urllib.request.Request(clean_url, headers=req_headers)
            
            success = False
            # 5-attempt retry loop with exponential backoff backoff
            for attempt in range(5):
                try:
                    with urllib.request.urlopen(req, context=ctx, timeout=15) as response:
                        status = response.getcode()
                        
                        if status not in (200, 206):
                            raise Exception(f"Unexpected HTTP response code: {status}")
                            
                        data = response.read()
                        out_file.write(data)
                        downloaded += len(data)
                        success = True
                        break
                except Exception as e:
                    log(f"Error downloading chunk {start}-{end} of {label} (attempt {attempt+1}/5): {e}")
                    time.sleep(2 ** attempt) # Exponential backoff: 1s, 2s, 4s, 8s...
            
            if not success:
                raise Exception(f"Failed to download chunk {start}-{end} of {label} after 5 attempts.")

            # Report progress
            fraction = downloaded / total_size
            pct = int(start_pct + fraction * (end_pct - start_pct))
            mb_downloaded = downloaded / (1024 * 1024)
            mb_total = total_size / (1024 * 1024)
            send_message({
                "status": "progress",
                "percent": pct,
                "statusLabel": f"Downloading {label}: {mb_downloaded:.1f}MB / {mb_total:.1f}MB"
            })
            
    log(f"Chunked download complete for {label}: {downloaded} bytes written.")

def download_file_direct(url, filepath, label, start_pct, end_pct, custom_headers=None):
    log(f"Downloading {label} (direct/fallback) to {filepath}")
    
    headers = filter_headers(custom_headers)
    clean_url = strip_range_param(url)
    req = urllib.request.Request(clean_url, headers=headers)
    
    with urllib.request.urlopen(req, context=ctx, timeout=20) as response:
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
                    send_message({
                        "status": "progress",
                        "percent": pct,
                        "statusLabel": f"Downloading {label}: {mb_downloaded:.1f}MB / {mb_total:.1f}MB"
                    })

def find_ffmpeg():
    local_ffmpeg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg.exe")
    if os.path.exists(local_ffmpeg):
        log(f"Found local FFmpeg: {local_ffmpeg}")
        return local_ffmpeg
    
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        log("Found system PATH FFmpeg")
        return "ffmpeg"
    except:
        pass
        
    return None

def find_ffprobe():
    local_ffprobe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffprobe.exe")
    if os.path.exists(local_ffprobe):
        log(f"Found local ffprobe: {local_ffprobe}")
        return local_ffprobe
    
    try:
        subprocess.run(["ffprobe", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        log("Found system PATH ffprobe")
        return "ffprobe"
    except:
        pass
        
    return None

def handle_download_and_mux(msg):
    video_url = msg.get("videoUrl")
    audio_url = msg.get("audioUrl")
    filename = msg.get("filename", "download.mp4")
    video_headers = msg.get("videoHeaders")
    audio_headers = msg.get("audioHeaders")
    
    downloads_dir = os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.exists(downloads_dir):
        downloads_dir = os.getcwd()
        
    log("Resolving YouTube stream metadata and container types...")
    
    # 1. Detect MIME types and total sizes
    video_mime, video_total_size = get_stream_info(video_url, video_headers)
    log(f"Video Stream — MIME: {video_mime}, Expected Size: {video_total_size} bytes")
    
    audio_mime = None
    audio_total_size = 0
    if audio_url:
        audio_mime, audio_total_size = get_stream_info(audio_url, audio_headers)
        log(f"Audio Stream — MIME: {audio_mime}, Expected Size: {audio_total_size} bytes")
        
    # 2. Determine container mappings correctly
    is_video_webm = "webm" in (video_mime or "")
    is_audio_webm = "webm" in (audio_mime or "")
    
    video_ext = ".webm" if is_video_webm else ".mp4"
    audio_ext = ".webm" if is_audio_webm else ".m4a"
    
    # We respect the requested extension (usually .mp4) to ensure Windows compatibility.
    # If the input is WebM but output is MP4, we will transcode it below.
    _, out_ext = os.path.splitext(filename)
    if not out_ext:
        out_ext = ".mp4"
        filename += out_ext
    final_filename = filename
    output_path = os.path.join(downloads_dir, final_filename)
    
    log(f"Output container determined: {out_ext} -> File: {output_path}")
    
    import uuid
    uid = uuid.uuid4().hex[:8]
    temp_video = os.path.join(tempfile.gettempdir(), f"ms_temp_video_{uid}{video_ext}")
    temp_audio = os.path.join(tempfile.gettempdir(), f"ms_temp_audio_{uid}{audio_ext}")
    
    try:
        # 3. Download tracks using the signature-preserving Range DASH range downloader
        download_chunked(video_url, temp_video, "video", 5, 50, video_total_size, video_headers)
        
        if audio_url:
            download_chunked(audio_url, temp_audio, "audio", 50, 80, audio_total_size, audio_headers)
            
        # 4. Validate downloaded file sizes to ensure 100% completion
        actual_video_size = os.path.getsize(temp_video)
        log(f"Video download complete. Size: {actual_video_size} bytes")
        if video_total_size > 0 and actual_video_size < video_total_size * 0.98:
            raise Exception(f"Video download is incomplete! Expected {video_total_size} but got {actual_video_size} bytes.")
            
        if audio_url:
            actual_audio_size = os.path.getsize(temp_audio)
            log(f"Audio download complete. Size: {actual_audio_size} bytes")
            if audio_total_size > 0 and actual_audio_size < audio_total_size * 0.98:
                raise Exception(f"Audio download is incomplete! Expected {audio_total_size} but got {actual_audio_size} bytes.")

        # 5. Mux tracks using FFmpeg
        ffmpeg_bin = find_ffmpeg()
        if not ffmpeg_bin:
            log("FFmpeg binary not found on host!")
            if not audio_url:
                os.replace(temp_video, output_path)
                send_message({"status": "complete", "statusLabel": f"Saved: {final_filename}"})
                return
            else:
                raise Exception("FFmpeg not found. Merging adaptive tracks requires FFmpeg.")
                
        send_message({"status": "progress", "percent": 85, "statusLabel": "Muxing tracks natively (FFmpeg)..."})
        
        cmd = [ffmpeg_bin]
        if audio_url:
            cmd += ["-i", temp_video, "-i", temp_audio]
            # Copy codecs if formats match, transcode to standard H.264/AAC if they want MP4 but input is VP9/WebM
            if is_video_webm and out_ext == ".mp4":
                log("Transcoding VP9 WebM video to standard H.264 for MP4 container compatibility...")
                cmd += ["-c:v", "libx264", "-preset", "superfast", "-crf", "22", "-c:a", "aac", "-b:a", "192k"]
            else:
                cmd += ["-c", "copy"]
            cmd += ["-y", output_path]
        else:
            cmd += ["-i", temp_video]
            if is_video_webm and out_ext == ".mp4":
                cmd += ["-c:v", "libx264", "-preset", "superfast", "-crf", "22"]
            else:
                cmd += ["-c", "copy"]
            cmd += ["-y", output_path]
            
        log(f"Executing: {' '.join(cmd)}")
        
        # Determine total duration for progress calculation
        ffprobe_bin = find_ffprobe()
        duration_sec = 0
        if video_url and ffprobe_bin:
            import re
            # Fast probe to get duration
            probe_cmd = [ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", temp_video]
            try:
                probe_res = subprocess.run(probe_cmd, stdout=subprocess.PIPE, text=True)
                duration_sec = float(probe_res.stdout.strip())
                log(f"Total video duration for transcoding: {duration_sec} seconds")
            except Exception as e:
                log(f"Failed to probe duration: {e}")

        # Execute FFmpeg and read stderr line by line for progress
        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1, universal_newlines=True)
        
        time_regex = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")
        for line in process.stderr:
            if "time=" in line and duration_sec > 0:
                match = time_regex.search(line)
                if match:
                    h, m, s = match.groups()
                    current_sec = int(h) * 3600 + int(m) * 60 + float(s)
                    fraction = current_sec / duration_sec
                    # Progress from 85% to 99%
                    pct = int(85 + fraction * 14)
                    send_message({"status": "progress", "percent": pct, "statusLabel": f"Transcoding for Windows compatibility... ({int(fraction*100)}%)"})
        
        process.wait()
        
        if process.returncode != 0:
            raise Exception(f"FFmpeg failed with exit code {process.returncode}.")
            
        # 6. Add ffprobe validation on the merged output file
        ffprobe_bin = find_ffprobe()
        if ffprobe_bin:
            log("Verifying merged output using ffprobe...")
            probe_cmd = [ffprobe_bin, "-v", "error", "-show_format", "-show_streams", output_path]
            probe_result = subprocess.run(probe_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            log(f"ffprobe validation return code: {probe_result.returncode}")
            if probe_result.returncode != 0:
                log(f"ffprobe detected errors: {probe_result.stderr}")
                raise Exception("ffprobe validation failed: Merged file contains layout or codec errors.")
            else:
                log("ffprobe verification successfully passed!")
        else:
            log("ffprobe not found. Skipping validation.")
            
        log("Muxing completed successfully!")
        send_message({"status": "complete", "statusLabel": f"Saved to Downloads: {final_filename}"})
        
    except Exception as e:
        log(f"Download/Mux task error: {e}")
        send_message({"status": "failed", "statusLabel": f"Host Error: {str(e)}"})
        
    finally:
        # Clean up temp files
        for f in (temp_video, temp_audio):
            if os.path.exists(f):
                try:
                    os.remove(f)
                except:
                    pass

def handle_ytdlp_download(msg):
    url = msg.get("url")
    filename = msg.get("filename", "download.mp4")
    quality = msg.get("quality", "1080")
    
    downloads_dir = os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.exists(downloads_dir):
        downloads_dir = os.getcwd()
        
    output_path = os.path.join(downloads_dir, filename)
    
    # Strip extension to prevent double extensions (e.g. .mp4.mp4) during post-processing
    output_path_without_ext, _ = os.path.splitext(output_path)
    
    log(f"Starting native yt-dlp download for {url} to {output_path}")
    
    final_path = None
    raw_filename = None
    
    try:
        import yt_dlp
        import subprocess
        
        # Resolve quality constraint
        # quality is height like '1080', '720', etc.
        # Format string selects standard mp4/m4a formats compatible with standard players
        # We prefer H264 (avc1) and AAC for maximum Windows Media Player compatibility!
        fmt = f"bestvideo[height<={quality}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<={quality}]+bestaudio/best[height<={quality}]"
        
        ffmpeg_bin = find_ffmpeg()
        
        def progress_hook(d):
            if d['status'] == 'downloading':
                downloaded = d.get('downloaded_bytes', 0)
                total = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
                
                info = d.get('info_dict', {})
                is_audio = info.get('vcodec') == 'none'
                
                if total > 0:
                    fraction = downloaded / total
                    if is_audio:
                        percent = int(50 + fraction * 30) # 50% to 80%
                    else:
                        percent = int(fraction * 50) # 0% to 50%
                else:
                    percent = 40
                
                mb_downloaded = downloaded / (1024 * 1024)
                mb_total = total / (1024 * 1024) if total > 0 else 0
                
                speed = d.get('speed', 0) or 0
                speed_label = f"{speed / (1024 * 1024):.1f} MB/s" if speed > 0 else ""
                
                status_label = f"Downloading: {mb_downloaded:.1f}MB"
                if mb_total > 0:
                    status_label += f" / {mb_total:.1f}MB"
                if is_audio:
                    status_label = "Audio: " + status_label
                else:
                    status_label = "Video: " + status_label
                    
                send_message({
                    "status": "progress",
                    "percent": percent,
                    "statusLabel": status_label + (f" ({speed_label})" if speed_label else "")
                })
            elif d['status'] == 'finished':
                send_message({
                    "status": "progress",
                    "percent": 85,
                    "statusLabel": "Merging and post-processing natively..."
                })
                
        ydl_opts = {
            'format': fmt,
            'outtmpl': output_path_without_ext + '.%(ext)s',
            'postprocessors': [{
                'key': 'FFmpegVideoConvertor',
                'preferedformat': 'mp4',
            }],
            'progress_hooks': [progress_hook],
            'nocheckcertificate': True,
            'verbose': True,
            'quiet': False,
            'no_warnings': False,
        }
        
        if ffmpeg_bin:
            # Tell yt-dlp where to find ffmpeg
            ffmpeg_dir = os.path.dirname(ffmpeg_bin)
            ydl_opts['ffmpeg_location'] = ffmpeg_dir
            log(f"Passing FFmpeg location to yt-dlp: {ffmpeg_dir}")
            
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            log("Extracting info and initiating download synchronously...")
            info = ydl.extract_info(url, download=True)
            
            raw_filename = ydl.prepare_filename(info)
            # After conversion by FFmpegVideoConvertor, the final extension is ALWAYS .mp4
            final_path = os.path.splitext(raw_filename)[0] + ".mp4"
            
            log(f"yt-dlp returned raw filename: {raw_filename}")
            log(f"Derived final MP4 path: {final_path}")
            
        # 1. Add strict post-download delay to allow Windows file flush to complete
        log("Adding 1-second delay for Windows file flush...")
        time.sleep(1)
        
        # 2. Strict file existence and size check
        if not os.path.exists(final_path):
            log(f"ERROR: Final output file does not exist: {final_path}")
            raise Exception("Final output missing")
            
        final_size = os.path.getsize(final_path)
        log(f"Final MP4 file size: {final_size} bytes ({final_size / (1024*1024):.2f} MB)")
        if final_size < 1024 * 500: # 500KB
            log("ERROR: Final MP4 file size is under 500KB! This indicates corruption.")
            raise Exception("Incomplete/corrupted download")
            
        # 3. Strict stream layout and header integrity check using ffprobe
        ffprobe_bin = find_ffprobe()
        if not ffprobe_bin:
            log("WARNING: ffprobe not found on host. Skipping strict layout integrity check.")
        else:
            log(f"Running strict stream layout validation using ffprobe: {ffprobe_bin}...")
            probe = subprocess.run(
                [ffprobe_bin, "-v", "error", "-show_streams", final_path],
                capture_output=True,
                text=True
            )
            log(f"ffprobe return code: {probe.returncode}")
            if probe.returncode != 0:
                log(f"ffprobe validation failed! stderr output:\n{probe.stderr}")
                log(f"ffprobe validation failed! stdout output:\n{probe.stdout}")
                raise Exception("Corrupted MP4 generated")
                
            # Strict validation: Reject outputs that still contain VP9, AV1, or Opus streams
            probe_out = probe.stdout.lower()
            if "codec_name=vp9" in probe_out or "codec_name=vp09" in probe_out or "codec_name=opus" in probe_out or "codec_name=av01" in probe_out:
                log(f"ERROR: Final MP4 file still contains incompatible codecs (VP9/AV1/Opus)! ffprobe output:\n{probe.stdout}")
                raise Exception("Corrupted MP4 generated: Incompatible codec remaining in container")
                
            log("ffprobe verification successfully passed!")
            
        log("yt-dlp download, merge, and verification completed successfully!")
        send_message({"status": "complete", "statusLabel": f"Saved to Downloads: {os.path.basename(final_path)}"})
        
    except Exception as e:
        log(f"yt-dlp download failed: {e}")
        # Automatically clean up corrupted final/partial files on failure to prevent empty/broken files
        for path in (final_path, raw_filename):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                    log(f"Cleaned up file on failure: {path}")
                except Exception as clean_err:
                    log(f"Failed to remove {path}: {clean_err}")
        # Clean up any potential .part files in the directory
        try:
            part_file = (output_path_without_ext + '.mp4.part')
            if os.path.exists(part_file):
                os.remove(part_file)
                log(f"Cleaned up .part file on failure: {part_file}")
            part_file2 = (output_path_without_ext + '.webm.part')
            if os.path.exists(part_file2):
                os.remove(part_file2)
                log(f"Cleaned up .part file on failure: {part_file2}")
        except Exception as part_err:
            log(f"Failed to clean up .part files: {part_err}")
            
        send_message({"status": "failed", "statusLabel": f"Host Error: {str(e)}"})

def worker_main(job_file):
    try:
        with open(job_file, 'r', encoding='utf-8') as f:
            msg = json.load(f)
    except Exception as e:
        log(f"Worker failed to load job file: {e}")
        return
        
    status_file = msg.get('__status_file')
    
    def worker_send_message(message_content):
        if status_file:
            try:
                with open(status_file, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(message_content) + "\n")
            except:
                pass
                
    # Override global send_message
    global send_message
    send_message = worker_send_message
    
    action = msg.get("action")
    log(f"Worker starting action: {action}")
    
    if action == "download_and_mux":
        handle_download_and_mux(msg)
    elif action == "download_youtube_ytdlp":
        handle_ytdlp_download(msg)
        
    try:
        os.remove(job_file)
    except:
        pass

def launch_detached_worker(msg):
    import uuid
    uid = uuid.uuid4().hex[:8]
    job_file = os.path.join(tempfile.gettempdir(), f"ms_job_{uid}.json")
    status_file = os.path.join(tempfile.gettempdir(), f"ms_status_{uid}.jsonl")
    
    msg['__status_file'] = status_file
    with open(job_file, 'w', encoding='utf-8') as f:
        json.dump(msg, f)
        
    CREATE_NO_WINDOW = 0x08000000
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    DETACHED_PROCESS = 0x00000008
    
    script_path = os.path.abspath(__file__)
    cmd = ["python", script_path, "--worker", job_file]
    
    log(f"Launching detached worker for job {uid}...")
    p = subprocess.Popen(
        cmd,
        creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL
    )
    log(f"Spawned detached worker PID {p.pid} for job {uid}")
    
    # Follow the status file
    last_pos = 0
    import time
    while True:
        if os.path.exists(status_file):
            with open(status_file, 'r', encoding='utf-8') as f:
                f.seek(last_pos)
                lines = f.readlines()
                last_pos = f.tell()
                
                for line in lines:
                    line = line.strip()
                    if not line: continue
                    try:
                        status_msg = json.loads(line)
                        send_message(status_msg)
                        if status_msg.get("status") in ("complete", "failed"):
                            log(f"Job {uid} finished with status {status_msg.get('status')}")
                            # Give a little time then delete status file
                            time.sleep(0.5)
                            try: os.remove(status_file)
                            except: pass
                            return
                    except Exception as e:
                        log(f"Error parsing status line: {e}")
        time.sleep(0.5)

def main():
    while True:
        try:
            msg = get_message()
            if msg is None:
                log("Stdin closed, exiting host.")
                break
                
            log(f"Received message: {json.dumps(msg)}")
            action = msg.get("action")
            
            if action == "ping":
                send_message({"status": "pong"})
            elif action in ("download_and_mux", "download_youtube_ytdlp"):
                # Run via detached worker to survive Chrome closure!
                launch_detached_worker(msg)
            else:
                send_message({"status": "failed", "statusLabel": "Unknown action: " + str(action)})
                
        except Exception as e:
            log(f"Main loop error: {e}")
            break

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker_main(sys.argv[2])
    else:
        main()
