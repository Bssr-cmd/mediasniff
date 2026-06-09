with open("scratch/base.js", "r", encoding="utf-8") as f:
    js = f.read()

import re

# Match the declaration of R
match = re.search(r'var R=\'(.*?)\'\.split\(";"\)', js)
if not match:
    match = re.search(r"var R='(.*?)'\.split\(';'\)", js)

r_str = match.group(1)
R = r_str.split(";")

B = 48
l = 5831
W = l ^ B

print(f"B={B}, l={l}, W={W}")
print(f"R[0] = {repr(R[0])}")

print(f"W^5845 = {W^5845} -> R[{W^5845}] = {repr(R[W^5845])}")
print(f"W^5818 = {W^5818} -> R[{W^5818}] = {repr(R[W^5818])}")
print(f"W^5881 = {W^5881}")
print(f"W^5852 = {W^5852} -> R[{W^5852}] = {repr(R[W^5852])}")
print(f"W^5869 = {W^5869}")
print(f"W^5812 = {W^5812} -> R[{W^5812}] = {repr(R[W^5812])}")
print(f"W^5887 = {W^5887}")
print(f"W^5865 = {W^5865}")
print(f"W^5842 = {W^5842} -> R[{W^5842}] = {repr(R[W^5842])}")
