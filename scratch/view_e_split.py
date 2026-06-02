with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

print(js[:2000])
with open("scratch/e_def.txt", "w", encoding="utf-8") as out:
    out.write(js[:5000])
