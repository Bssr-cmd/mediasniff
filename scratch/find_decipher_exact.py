with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re
# Find the exact index where Z_[e[d^510]](F,4) is located
idx = js.find("Z_[e[d^510]](F,4)")
if idx != -1:
    print(f"Found target string at index {idx}")
    
    # We want to find the enclosing function definition.
    # Usually a function starts with: `[a-zA-Z0-9$_]+\s*=\s*function\(`
    # Let's search backwards for the nearest `function(` pattern.
    start_pos = idx
    func_pattern = re.compile(r'\b[a-zA-Z0-9$_]+\s*=\s*function\s*\(')
    
    # Let's search backwards up to 5000 characters
    search_area = js[max(0, start_pos - 15000):start_pos]
    matches = list(func_pattern.finditer(search_area))
    if matches:
        last_match = matches[-1]
        real_start_idx = max(0, start_pos - 15000) + last_match.start()
        print(f"Nearest function start found at index {real_start_idx}:")
        print(js[real_start_idx:start_pos+300])
    else:
        print("Could not find preceding function definition within 15000 chars.")
else:
    print("Could not find target string Z_[e[d^510]](F,4)")
