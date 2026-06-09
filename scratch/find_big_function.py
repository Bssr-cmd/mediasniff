with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

idx = js.find("var W=l^B;")
if idx != -1:
    print(f"Found var W=l^B; at {idx}")
    # Search backwards for the function name assignment
    start = max(0, idx - 100)
    print(js[start:idx+1500])
else:
    print("Not found")
