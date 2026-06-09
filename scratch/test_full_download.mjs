import fetch from 'node-fetch';
global.fetch = fetch;

import { YouTubeDownloader } from '../lib/youtube-downloader.js';

async function run() {
  console.log("Starting getDownloadUrl test...");
  try {
    const result = await YouTubeDownloader.getDownloadUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw', '1080');
    console.log("Result:", result);
  } catch(e) {
    console.error("Error:", e);
  }
}

run();
