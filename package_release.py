#!/usr/bin/env python3
"""
MediaSniff Release Packager
Packages the companion app and extension into clean zip archives ready for distribution.
"""
import os
import zipfile
import shutil

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(REPO_ROOT, "dist")
COAPP_DIR = os.path.join(REPO_ROOT, "coapp")

os.makedirs(DIST_DIR, exist_ok=True)

def package_companion_app():
    zip_name = "mediasniff-companion-windows-x64.zip"
    zip_path = os.path.join(DIST_DIR, zip_name)
    
    print(f"Building {zip_name}...")
    
    # Files to include in the companion distribution
    include_files = [
        "coapp.py",
        "coapp.bat",
        "install.bat",
        "install_coapp.ps1",
        "install_coapp.py",
        "uninstall.bat",
        "uninstall_coapp.ps1",
        "net.mediasniff.coapp.json",
        "download_ffmpeg.py"
    ]
    
    # Also include binaries if present
    for bin_file in ["yt-dlp.exe", "ffmpeg.exe"]:
        bin_path = os.path.join(COAPP_DIR, bin_file)
        if os.path.exists(bin_path):
            include_files.append(bin_file)

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for fname in include_files:
            fpath = os.path.join(COAPP_DIR, fname)
            if os.path.exists(fpath):
                arcname = os.path.join("mediasniff-companion", fname)
                zf.write(fpath, arcname)
                print(f"  + Added: {fname} ({os.path.getsize(fpath):,} bytes)")
            else:
                print(f"  - Missing: {fname}")

        # Include portable Python directory if present
        py_dir = os.path.join(COAPP_DIR, "python")
        if os.path.exists(py_dir):
            print("  + Packaging portable Python runtime...")
            for root, dirs, files in os.walk(py_dir):
                for file in files:
                    fpath = os.path.join(root, file)
                    rel_to_coapp = os.path.relpath(fpath, COAPP_DIR)
                    arcname = os.path.join("mediasniff-companion", rel_to_coapp)
                    zf.write(fpath, arcname)
            print("  + Portable Python packaged successfully.")

    print(f"Package created: {zip_path} ({os.path.getsize(zip_path):,} bytes)")
    return zip_path

def package_extension():
    zip_name = "mediasniff-chrome-extension.zip"
    zip_path = os.path.join(DIST_DIR, zip_name)
    
    print(f"\nBuilding {zip_name}...")
    
    ignore_dirs = {'.git', '.agents', 'scratch', 'dist', '__pycache__', 'coapp', 'yt-dlp-repo', 'tests'}
    ignore_files = {'test.html', 'test.js', 'test_fetch.html', 'test_hls.mp4', '.gitignore'}
    ignore_exts = {'.pyc', '.log', '.zip', '.exe'}

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(REPO_ROOT):
            dirs[:] = [d for d in dirs if d not in ignore_dirs]
            for file in files:
                if file in ignore_files:
                    continue
                ext = os.path.splitext(file)[1].lower()
                if ext in ignore_exts:
                    continue
                fpath = os.path.join(root, file)
                relpath = os.path.relpath(fpath, REPO_ROOT)
                zf.write(fpath, relpath)
                print(f"  + Added: {relpath}")

    print(f"Package created: {zip_path} ({os.path.getsize(zip_path):,} bytes)")
    return zip_path

if __name__ == '__main__':
    print("=" * 60)
    print("MediaSniff Release Packaging")
    print("=" * 60)
    coapp_zip = package_companion_app()
    ext_zip = package_extension()
    print("\nRelease packages successfully built in /dist:")
    print(f"  1. Companion App: {coapp_zip}")
    print(f"  2. Extension:     {ext_zip}")
    print("=" * 60)
