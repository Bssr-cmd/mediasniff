/**
 * Test YouTube download pipeline in Node.js
 */
const https = require('https');

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

function postUrl(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function testInnertube(videoId) {
  console.log(`\n=== Testing Innertube for ${videoId} ===`);
  const clientVersion = '2.20260602.06.00';
  const url = `https://www.youtube.com/youtubei/v1/player?key=`; // need key, actually we can just hit the API with a known body
  // Wait, the youtube-downloader.js code extracts the API key from the page.
}

// Let's just run the youtube-downloader.js using Node.js instead, by importing it
