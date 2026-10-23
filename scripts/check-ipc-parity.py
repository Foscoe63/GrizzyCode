import re, sys

preload_src = open('src/preload.js').read()
main_src = open('src/main/main.js').read()

# Channels referenced in preload via inv('x') / on('x')
preload_channels = set(re.findall(r"inv\('([^']+)'\)", preload_src)) | set(re.findall(r"on\('([^']+)'\)", preload_src))
preload_channels |= set(re.findall(r"inv\(\"([^\"]+)\"\)", preload_src)) | set(re.findall(r"on\(\"([^\"]+)\"\)", preload_src))

# Channels registered in main via h('x') / onEvt('x')
main_channels = set(re.findall(r"\bh\('([^']+)'", main_src)) | set(re.findall(r"\bonEvt\('([^']+)'", main_src))

missing = sorted(preload_channels - main_channels)
extra = sorted(main_channels - preload_channels)

print(f"preload channels: {len(preload_channels)}")
print(f"main channels:    {len(main_channels)}")
print()
print(f"=== MISSING in main.js ({len(missing)}) ===")
for c in missing:
    print(f"  {c}")
print()
print(f"=== EXTRA in main.js ({len(extra)}) ===")
for c in extra:
    print(f"  {c}")

# Count exposed API groups
groups = re.findall(r"^  (\w+):", preload_src, re.M)
print()
print(f"=== context-bridge top-level API groups ({len(groups)}) ===")
print(", ".join(groups))

sys.exit(1 if missing else 0)
