const urlParams = new URLSearchParams(window.location.search);
const itemId = urlParams.get("itemId");
const tabId = parseInt(urlParams.get("tabId"));
const filename = urlParams.get("filename") || "download.mp4";

async function startDownload() {
  const statusEl = document.getElementById("status");
  const fillEl = document.getElementById("fill");
  
  try {
    statusEl.textContent = "Please select where to save the file...";
    const handle = await window.showSaveFilePicker({ suggestedName: filename });
    const writable = await handle.createWritable();
    
    // Request item data from background
    const msg = { type: "GET_MEDIA" };
    if (tabId && !isNaN(tabId)) msg.tabId = tabId;
    const response = await new Promise(r => chrome.runtime.sendMessage(msg, r));
    const allMedia = response?.media || [];
    const item = allMedia.find(m => m.id === itemId);
    if (!item) throw new Error("Media item not found");
    
    // Resolve segments: check variant segments, then item-level segments
    let segments = null;
    let initUrl = null;
    if (item.variants && item.variants.length > 0 && item.variants[0].segments && item.variants[0].segments.length > 0) {
      segments = item.variants[0].segments;
      initUrl = item.variants[0].initUrl || null;
    } else if (item.segments && item.segments.length > 0) {
      segments = item.segments;
      initUrl = item.initUrl || null;
    }
    if (!segments || segments.length === 0) throw new Error("No segments found for streaming.");
    
    statusEl.textContent = "Downloading...";
    
    // Fetch and write initialization segment first (required for fMP4)
    if (initUrl) {
      statusEl.textContent = "Downloading init segment...";
      const initRes = await fetch(initUrl);
      if (initRes.ok) {
        const initBuffer = await initRes.arrayBuffer();
        await writable.write(initBuffer);
      }
    }
    
    // Download and write each media segment
    for (let i = 0; i < segments.length; i++) {
      // Segments can be plain URL strings or objects with a .url property
      const segUrl = typeof segments[i] === 'string' ? segments[i] : segments[i].url;
      if (!segUrl) throw new Error("Segment " + i + " has no URL");
      
      const res = await fetch(segUrl);
      if (!res.ok) throw new Error("Failed to fetch chunk " + i);
      
      const buffer = await res.arrayBuffer();
      await writable.write(buffer);
      
      const percent = Math.round(((i + 1) / segments.length) * 100);
      fillEl.style.width = percent + "%";
      statusEl.textContent = `Downloading... ${percent}%`;
    }
    
    await writable.close();
    statusEl.textContent = "Download Complete!";
    statusEl.style.color = "#4caf50";
    
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.style.color = "#f44336";
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
