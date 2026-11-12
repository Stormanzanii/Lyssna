#!/bin/sh
# Every [[bin]] is bundled beside the app. Apple's linker signs arm64 builds
# but not x86_64 ones, and signing the app fails on an unsigned helper.
target="${CARGO_TARGET_DIR:-target}"
for helper in "$target"/*/lyssna-release "$target"/*/*/lyssna-release; do
  [ -f "$helper" ] || continue
  codesign --verify "$helper" 2>/dev/null || codesign --force --sign - "$helper"
done
exit 0
