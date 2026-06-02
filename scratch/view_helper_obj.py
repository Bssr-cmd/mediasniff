with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

idx = 2097946
start = idx - 1000
end = idx + 1000
print(js[start:end])
