import subprocess
import os
import re

chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
html_path = os.path.abspath("test.html")
url = "file:///" + html_path.replace("\\", "/")
cmd = [chrome_path, "--headless=new", "--disable-gpu", "--allow-file-access-from-files", "--dump-dom", url]
p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
dom = p.stdout
passes = len(re.findall(r'class="status pass"', dom))
fails = len(re.findall(r'class="status fail"', dom))
summary_match = re.search(r'<div id="summary"[^>]*>(.*?)</div>', dom, re.DOTALL)
if summary_match:
    clean_summary = re.sub(r'<[^>]+>', ' ', summary_match.group(1)).strip()
    print("DOM Summary:", clean_summary)
if fails > 0:
    for m in re.finditer(r'<div class="test-item"[^>]*id="([^"]+)"[^>]*>.*?class="test-name">([^<]+)</div>.*?class="test-detail">([^<]*)</div>', dom, re.DOTALL):
        if 'fail' in m.group(0):
            print(f"FAILED TEST: {m.group(1)} ({m.group(2)}) -> {m.group(3)}")
print(f"Results: {passes} PASSED, {fails} FAILED (Total: {passes + fails})")
assert passes == 23 and fails == 0, f"Expected 23/23 pass, got {passes} pass, {fails} fail"
print("SUCCESS: Exact 23/23 parser and transmuxer tests verified in Chrome.")

