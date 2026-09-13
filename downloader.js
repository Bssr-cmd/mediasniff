import { TSToMP4Converter } from "./lib/ts-converter.js";
import { HLSParser } from "./lib/hls-parser.js";

const urlParams = new URLSearchParams(window.location.search);
const itemId = urlParams.get("itemId");
const tabId = parseInt(urlParams.get("tabId"));
const qualityIndex = parseInt(urlParams.get("qualityIndex") || "0");
let filename = urlParams.get("filename") || "download.mp4";

if (!/\.mp4$/i.test(filename) && !/\.m4a$/i.test(filename)) {
  filename = filename.replace(/\.[^.]+$/, '') + '.mp4';
}

async function startDownload() {
  const statusEl = document.getElementById("status");
  const fillEl = document.getElementById("fill");
  let writable = null;
  
  try {
    statusEl.textContent = "Please select where to save the file...";
    const handle = await window.showSaveFilePicker({ suggestedName: filename });
    writable = await handle.createWritable();
    
    // Request item data from background
    const msg = { type: "GET_MEDIA" };
    if (tabId && !isNaN(tabId)) msg.tabId = tabId;
    const response = await new Promise(r => chrome.runtime.sendMessage(msg, r));
    const allMedia = response?.media || [];
    const item = allMedia.find(m => m.id === itemId);
    if (!item) throw new Error("Media item not found");
    
    // Resolve segments: check selected variant, first variant, then item-level segments
    let segments = null;
    let initUrl = null;
    let targetUrl = item.url;

    if (item.variants && item.variants.length > 0) {
      const v = item.variants[qualityIndex] || item.variants[0];
      targetUrl = v.url || item.url;
      segments = v.segments;
      initUrl = v.initUrl || null;
    } else if (item.segments && item.segments.length > 0) {
      segments = item.segments;
      initUrl = item.initUrl || null;
    }

    // Fallback: If segments are not yet parsed, fetch the playlist manifest
    if (!segments || segments.length === 0) {
      statusEl.textContent = "Fetching playlist manifest...";
      const res = await fetch(targetUrl);
      if (!res.ok) throw new Error(`Failed to fetch playlist (${res.status})`);
      const playlistText = await res.text();
      const parsed = HLSParser.parse(playlistText, targetUrl);
      
      if (parsed.segments && parsed.segments.length > 0) {
        segments = parsed.segments;
        initUrl = parsed.initSegment || null;
      } else if (parsed.variants && parsed.variants.length > 0) {
        const subVar = parsed.variants[qualityIndex] || parsed.variants[0];
        const subRes = await fetch(subVar.url);
        if (!subRes.ok) throw new Error(`Failed to fetch variant playlist (${subRes.status})`);
        const subText = await subRes.text();
        const subParsed = HLSParser.parse(subText, subVar.url);
        segments = subParsed.segments;
        initUrl = subParsed.initSegment || null;
      }
    }

    if (!segments || segments.length === 0) {
      throw new Error("No media segments found in stream.");
    }

    statusEl.textContent = `Downloading ${segments.length} segments...`;
    
    // Fetch and write initialization segment first (required for fMP4)
    if (initUrl) {
      statusEl.textContent = "Downloading init segment...";
      const initRes = await fetch(initUrl);
      if (initRes.ok) {
        const initBuffer = await initRes.arrayBuffer();
        await writable.write(initBuffer);
      }
    }
    
    // Download segments
    const isFragmentedMp4 = Boolean(initUrl);
    const tsChunks = isFragmentedMp4 ? null : [];

    for (let i = 0; i < segments.length; i++) {
      const segUrl = typeof segments[i] === 'string' ? segments[i] : segments[i].url;
      if (!segUrl) throw new Error("Segment " + i + " has no URL");
      
      const res = await fetch(segUrl);
      if (!res.ok) throw new Error(`Failed to fetch segment ${i + 1}/${segments.length}`);
      
      const buffer = await res.arrayBuffer();

      if (isFragmentedMp4) {
        await writable.write(buffer);
      } else {
        tsChunks.push(new Uint8Array(buffer));
      }
      
      const percent = Math.round(((i + 1) / segments.length) * (isFragmentedMp4 ? 100 : 85));
      fillEl.style.width = percent + "%";
      statusEl.textContent = `Downloading: ${i + 1}/${segments.length} (${percent}%)`;
    }
    
    // For MPEG-TS, transmux to ISO BMFF MP4 before finalizing
    if (!isFragmentedMp4 && tsChunks) {
      statusEl.textContent = "Transmuxing MPEG-TS to standard MP4...";
      fillEl.style.width = "90%";

      const mp4Blob = TSToMP4Converter.convert(tsChunks, (convProgress) => {
        const overall = Math.round(90 + convProgress * 9);
        fillEl.style.width = overall + "%";
        statusEl.textContent = `Converting MPEG-TS to MP4 (${Math.round(convProgress * 100)}%)...`;
      });

      statusEl.textContent = "Writing MP4 to disk...";
      await writable.write(mp4Blob);
    }

    await writable.close();
    writable = null;

    fillEl.style.width = "100%";
    statusEl.textContent = "Download Complete! Saved as MP4.";
    statusEl.style.color = "#4caf50";
    
  } catch (err) {
    console.error("[MediaSniff Downloader] Error:", err);
    statusEl.textContent = "Error: " + err.message;
    statusEl.style.color = "#f44336";
    if (writable) {
      try { await writable.abort(); } catch (_) {}
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // We need a user gesture to trigger showSaveFilePicker
  const btn = document.createElement("button");
  btn.textContent = "Start Download";
  btn.style.padding = "10px 20px";
  btn.style.cursor = "pointer";
  btn.onclick = () => {
    btn.style.display = "none";
    startDownload();
  };
  document.querySelector(".card").appendChild(btn);
});
