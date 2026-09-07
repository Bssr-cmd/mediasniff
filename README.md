<div align="center">
  <img src="icons/icon128.png" alt="MediaSniff Logo" width="128">
  <h1>MediaSniff</h1>
  <p><strong>A robust, ultra-fast browser extension for intercepting, processing, and downloading streaming media.</strong></p>
</div>

<br />

## 📖 What is MediaSniff?

Have you ever tried to download a video from a website, only to find that it's broken up into hundreds of tiny, unplayable chunks? Modern websites use streaming protocols (like HLS or DASH) to prevent easy downloading. 

**MediaSniff** solves this problem entirely inside your browser. It acts like a radar—listening to the network traffic on any webpage you visit. When a website tries to load a fragmented video, MediaSniff intercepts the playlist, downloads all the tiny video and audio chunks concurrently at lightning speed, and seamlessly merges them together into a single, playable `.mp4` file for you to save.

No external servers, no cloud processing, no bloated dependencies. Your data stays completely private.

---

## 🎮 How to Use (For Regular Users)

1. **Pin the Extension:** Make sure the MediaSniff icon is pinned to your browser toolbar.
2. **Visit a Video Page:** Go to any website with a video you want to download (e.g., Vimeo, educational platforms, etc.).
3. **Play the Video:** Start playing the video. This forces the website to request the video data so MediaSniff can detect it.
4. **Open MediaSniff:** Click the MediaSniff icon in your toolbar. You will see a list of detected media files.
5. **Download:** 
   - Choose your preferred video quality and audio track.
   - Click the **Mux** button to download the video and audio combined into one file.
   - Any available subtitles will automatically download alongside your video as a `.vtt` file!

---

## 🌟 Core Capabilities (For Power Users)

* **Intelligent Network Interception:** Monitors network traffic to sniff `.m3u8` and `.mpd` playlists, automatically filtering out dummy child nodes and cross-CDN duplicates to present a clean, unified view.
* **Concurrent Chunk Harvesting:** Employs an asynchronous download pool (8x concurrency) to fetch video and audio segments in parallel, drastically reducing download times.
* **In-Browser WASM Multiplexing:** Utilizes a custom WebAssembly muxer to interleave disparate audio and video streams into standard ISO BMFF `.mp4` containers right in your browser's memory.
* **Segmented Subtitle Assembly:** Automatically detects HLS segmented subtitles, downloads individual `.vtt` chunks, strips out redundant headers, and seamlessly concatenates them into valid, player-ready subtitle files.
* **Fallback Stream Resolution:** Gracefully handles unsupported codecs (like WebM) by intelligently falling back to the highest available MP4 equivalent.
* **Premium UI:** A meticulously crafted, responsive popup interface featuring real-time bandwidth metrics, progress monitoring, and dynamic thumbnail extraction.

---

## 🚀 Installation

1. Clone or download this repository to your computer as a `.zip` file, and extract it.
2. Navigate to `chrome://extensions/` in your Chromium-based browser (Chrome, Edge, Brave, etc.).
3. Toggle **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the extracted `mediasniff` folder.
5. Pin the extension to your toolbar.

---

## 🏗️ Architecture & Stack (For Developers)

MediaSniff is structured for maximum modularity and strictly adheres to modern Chrome Extension Manifest V3 guidelines.

| Component | Responsibility |
| :--- | :--- |
| **Service Worker** | Network interception, state management, background download orchestration. |
| **Offscreen Document** | Houses the WASM Muxer, DOMParser for DASH manifests, and memory-heavy segment assembly to keep the background worker lightweight. |
| **Content Script** | Interrogates the DOM for rich metadata (OpenGraph/Twitter cards) to dynamically generate context-aware filenames and thumbnails. |
| **Popup UI** | Communicates with the service worker via Message Passing to reflect real-time network discoveries and active background download states. |

### Technical Highlights
- **Manifest V3:** Fully compliant with Chrome's strictest security and background lifecycle rules.
- **Zero-Dependency Core:** HLS/DASH parsing and TS transmuxing engines are written from scratch to minimize bundle size.
- **Auto-Deduplication Engine:** Employs aggressive URL pathname analysis to ensure parent-child playlist relationships are respected and the UI remains clutter-free.

---

## 🤝 Contributing

We welcome contributions from the community. Whether it's expanding codec support, optimizing the WASM pipeline, or refining the UI, please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
