with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

print("First 4000 characters:")
print(js[:4000])
