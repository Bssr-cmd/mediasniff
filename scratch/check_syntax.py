"""Smarter syntax check - counts brace/paren balance ignoring string literals and regex."""
import re

with open("lib/youtube-downloader.js", "r", encoding="utf-8") as f:
    content = f.read()

# Strip string literals and regex patterns to avoid false positives
# Replace strings with placeholder
cleaned = re.sub(r"'(?:[^'\\]|\\.)*'", '""', content)  # single-quoted strings
cleaned = re.sub(r'"(?:[^"\\]|\\.)*"', '""', cleaned)  # double-quoted strings  
cleaned = re.sub(r'`(?:[^`\\]|\\.)*`', '""', cleaned)  # template literals
cleaned = re.sub(r'/(?:[^/\\]|\\.)+/[gimsy]*', '""', cleaned)  # regex literals (basic)
# Remove single-line comments
cleaned = re.sub(r'//[^\n]*', '', cleaned)
# Remove multi-line comments
cleaned = re.sub(r'/\*[\s\S]*?\*/', '', cleaned)

braces = 0
parens = 0
brackets = 0
for c in cleaned:
    if c == '{': braces += 1
    elif c == '}': braces -= 1
    elif c == '(': parens += 1
    elif c == ')': parens -= 1
    elif c == '[': brackets += 1
    elif c == ']': brackets -= 1

print(f"Braces balance:   {braces} {'OK' if braces == 0 else 'UNBALANCED!'}")
print(f"Parens balance:   {parens} {'OK' if parens == 0 else 'UNBALANCED!'}")
print(f"Brackets balance: {brackets} {'OK' if brackets == 0 else 'UNBALANCED!'}")

if braces != 0 or parens != 0 or brackets != 0:
    # Find the location of the imbalance
    line = 1
    col = 0
    brace_stack = []
    paren_stack = []
    for i, c in enumerate(cleaned):
        col += 1
        if c == '\n':
            line += 1
            col = 0
        elif c == '{':
            brace_stack.append((line, col))
        elif c == '}':
            if brace_stack:
                brace_stack.pop()
            else:
                print(f"  Extra '}}' at line {line}, col {col}")
        elif c == '(':
            paren_stack.append((line, col))
        elif c == ')':
            if paren_stack:
                paren_stack.pop()
            else:
                print(f"  Extra ')' at line {line}, col {col}")
    
    for loc in brace_stack:
        print(f"  Unmatched '{{' at line {loc[0]}, col {loc[1]}")
    for loc in paren_stack:
        print(f"  Unmatched '(' at line {loc[0]}, col {loc[1]}")
    
    exit(1)
else:
    print("\nFile syntax looks OK (balanced delimiters after stripping strings)")
