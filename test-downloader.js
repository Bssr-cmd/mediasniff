// Use native fetch (Node 18+)
async function fetchActiveInstances() {
    try {
        const resp = await fetch('https://api.invidious.io/instances.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const instances = await resp.json();

        const working = [];
        for (const [domain, info] of instances) {
            if (info.type === 'https' && info.monitor && info.monitor.down === false) {
                working.push({
                    uri: info.uri || `https://${domain}`,
                    uptime: info.monitor.uptime || 0
                });
            }
        }

        working.sort((a, b) => b.uptime - a.uptime);
        return working.map(w => w.uri);
    } catch (e) {
        console.error('Failed to fetch dynamic Invidious instances:', e.message);
        return [];
    }
}
async function testInstances() {
    const instances = await fetchActiveInstances();
    console.log(`Found ${instances.length} active Invidious instances. Testing top 10...`);

    const videoId = 'dQw4w9WgXcQ'; // Sample video

    for (const instance of instances.slice(0, 15)) {
        try {
            console.log(`Testing ${instance}...`);
            const resp = await fetch(`${instance}/api/v1/videos/${videoId}`, {
                headers: { 'Accept': 'application/json' }
            });
            if (!resp.ok) {
                console.log(`  -> Failed with HTTP ${resp.status}`);
                continue;
            }
            const data = await resp.json();
            const adaptiveFormats = data.adaptiveFormats || [];
            const videoStreams = adaptiveFormats.filter(f => f.type?.startsWith('video/') && f.url);
            const combinedStreams = data.formatStreams || [];

            console.log(`  -> Success! Title: "${data.title}"`);
            console.log(`  -> Adaptive Video Streams: ${videoStreams.length}`);
            console.log(`  -> Combined Streams: ${combinedStreams.length}`);
            if (videoStreams.length > 0 || combinedStreams.length > 0) {
                console.log(`  -> FOUND WORKING INSTANCE: ${instance}`);
                return;
            }
        } catch (e) {
            console.log(`  -> Error: ${e.message}`);
        }
    }
    console.log('No working instances found in top 15.');
}
testInstances();