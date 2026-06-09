const https = require('https');
const fs = require('fs');

https.get('https://www.youtube.com/watch?v=jNQXAC9IVRw', (res) => {
  let html = '';
  res.on('data', d => html += d);
  res.on('end', () => {
    const match = html.match(/"(\/[^"]+\/base\.js)"/);
    if (match) {
      const jsUrl = 'https://www.youtube.com' + match[1];
      console.log('Found base.js URL:', jsUrl);
      https.get(jsUrl, (jsRes) => {
        let js = '';
        jsRes.on('data', d => js += d);
        jsRes.on('end', () => {
          fs.writeFileSync('base.js', js);
          console.log('Saved base.js');
          
          // Try to find the decipher function name
          const nameMatch1 = js.match(/\b[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(/);
          const nameMatch2 = js.match(/\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(/);
          const nameMatch3 = js.match(/(?:\.sig\|\|([a-zA-Z0-9$]+)\()/);
          const nameMatch4 = js.match(/\.set\("signature",\s*([a-zA-Z0-9$]+)\(/);
          
          console.log('Name match 1:', nameMatch1 ? nameMatch1[1] : null);
          console.log('Name match 2:', nameMatch2 ? nameMatch2[1] : null);
          console.log('Name match 3:', nameMatch3 ? nameMatch3[1] : null);
          console.log('Name match 4:', nameMatch4 ? nameMatch4[1] : null);
          
          const sigName = (nameMatch1 || nameMatch2 || nameMatch3 || nameMatch4)?.[1];
          if (sigName) {
            const escapedName = sigName.replace(/\$/g, '\\$');
            const funcRegex = new RegExp(`(?:^|[^a-zA-Z0-9$])${escapedName}\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{([^}]+)\\}`);
            const funcMatch = js.match(funcRegex);
            console.log('Function body:', funcMatch ? funcMatch[1] : null);
          }
        });
      });
    }
  });
});
