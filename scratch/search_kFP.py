with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

start_idx = js.find("kFP=")
if start_idx != -1:
    print(js[start_idx:start_idx+1500])
else:
    print("Not found")
