with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

idx = 141296
start = idx - 1000
end = idx + 1000
print(js[start:end])
