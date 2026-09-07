const urlParams = new URLSearchParams(window.location.search);
const itemId = urlParams.get("itemId");
const filename = urlParams.get("filename") || "download.mp4";

async function startDownload() {
  const statusEl = document.getElementById("status");
  const fillEl = document.getElementById("fill");
  
  try {
    statusEl.textContent = "Please select where to save the file...";
    const handle = await window.showSaveFilePicker({ suggestedName: filename });
    const writable = await handle.createWritable();
    
    // Request item data from background
    const response = await new Promise(r => chrome.runtime.sendMessage({ type: "GET_MEDIA" }, r));
    const item = response.media.find(m => m.id === itemId);
    if (!item) throw new Error("Media item not found");
    
    let segments = item.variants && item.variants[0] ? item.variants[0].segments : [];
    if (!segments || segments.length === 0) throw new Error("No segments found for streaming.");
    
    statusEl.textContent = "Downloading...";
    
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const res = await fetch(seg.url);
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

