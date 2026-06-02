import re

def main():
    with open("scratch/base.js", "r", encoding="utf-8") as f:
        js = f.read()

    print("Searching for swap pattern: a[0] = a[...")
    swap_matches = []
    # Let's search for `[0]` followed by assignment of another index, and then index set to temp
    # pattern: var X = a[0]; a[0] = a[Y]; a[Y] = X
    # since it's minified, let's look for:
    # [a-zA-Z0-9$_]+\[0\]\s*=\s*[a-zA-Z0-9$_]+\[[a-zA-Z0-9$_%]+\]
    # e.g., z[0] = z[D % z.length]
    pattern1 = r'([a-zA-Z0-9$_]+)\[0\]\s*=\s*\1\[([a-zA-Z0-9$_%]+)\]'
    for m in re.finditer(pattern1, js):
        start = max(0, m.start() - 100)
        end = min(len(js), m.end() + 100)
        print(f"Swap match at {m.start()}:\n{js[start:end]}\n{'-'*50}")

    print("\nSearching for slice/splice/reverse in base.js:")
    # Let's find functions that contain `.reverse()` and are near other interesting code
    # or methods like `splice(0,`
    pattern2 = r'\.reverse\(\)'
    for m in re.finditer(pattern2, js):
        start = max(0, m.start() - 100)
        end = min(len(js), m.end() + 100)
        print(f"Reverse match at {m.start()}:\n{js[start:end]}\n{'-'*50}")

if __name__ == '__main__':
    main()
