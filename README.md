# 📡 MediaSniff Chrome Extension

An advanced, high-performance browser extension (Manifest V3) designed to sniff, parse, and download video and audio streams. Featuring concurrent chunk downloading, in-browser WASM multiplexing, smart dynamic naming, and a premium glassmorphic dark-mode interface.

---

## ✨ Features

- **📡 Advanced Network Sniffing**
  - Live traffic interception of HLS (`.m3u8`) and DASH (`.mpd`) streaming playlists.
  - Automatic detection of standard media types (`.mp4`, `.mp3`, `.webm`, etc.) and subtitles (`.vtt`, `.srt`).
  - Native signature-protected stream analysis and resolution-tier retrieval.

- **⚡ Concurrent Segment Downloader**
  - Downloads tiny `.ts` / `.m4s` chunks asynchronously using **8x parallel execution**.
  - Auto-retries failed chunks with dynamic bandwidth speed estimation (MB/s).

- **🧩 In-Browser WASM Multiplexing**
  - Seamlessly interleaves separate audio and video tracks into a unified `.mp4` file on the fly.
  - Done entirely inside your browser using **WebAssembly**—zero server dependencies!

- **🖼️ Rich Media Previews**
  - Dynamic thumbnail generation utilizing page-level OpenGraph, Twitter Cards, and schema markup.
  - Standalone quality select badges and custom media card views.

- **🧹 Smart Context Naming**
  - Automatically sanitizes and generates friendly filenames (e.g. `Creator - Video Title (1080p).mp4`) using document metadata and stream resolution details.
  - Smart deduplication filters out repetitive caching, CDN variations, and raw chunk listings.

---

## 🚀 Installation & Getting Started

1. **Download / Clone** this repository to your local machine.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `mediasniff` extension directory containing `manifest.json`.
6. Pin **MediaSniff** to your extension bar and navigate to any page with media players to start sniffing!

---

## 📂 Project Architecture

```
mediasniff/
├── manifest.json                 # Manifest V3 Configuration
├── background/
│   └── service-worker.js         # Intercepts requests, handles badge counts & downloads
├── content/
│   └── content.js                # DOM mutation scanner, YouTube player scraper, and thumbnails
├── lib/
│   ├── dash-parser.js            # Standard-compliant DASH parser
│   ├── hls-parser.js             # Standard-compliant HLS playlist parser
│   ├── muxer.js                  # High-performance WASM Muxing layer
│   ├── segment-downloader.js     # Asynchronous chunk manager with 8x concurrency
│   └── transmuxer.js             # MPEG-TS to fMP4 repackager
├── popup/
│   ├── popup.html                # Premium glassmorphic structure
│   ├── popup.css                 # Stunning styling, animations & radar sweeps
│   └── popup.js                  # Popup view controller and variant select pipeline
├── test.html                     # Visual automated component test runner
└── preview.html                  # Component mock layout prototyping
```

---

## 🛠️ Verification & Testing

Open `test.html` directly in your browser or run it through local server hosting to validate HLS master parsers, DASH segment lists, WebAssembly memory bounds, and the transmuxer binary engine.

---

## 📜 License

This project is open-source and available under the [MIT License](LICENSE).
