#!/usr/bin/env bash
# Installs Piper, a free offline neural voice, for the manager's spoken summary (plays even with the phone locked).
# ~110 MB, nothing else on the machine is touched. Run once: bash scripts/install-piper.sh
set -euo pipefail
D="${PIPER_DIR:-$HOME/.local/share/remote-terminal/piper}"
V=en_US-lessac-medium
mkdir -p "$D"; cd "$D"
curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz | tar xz
for e in onnx onnx.json; do curl -fsSL -o "$V.$e" "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/$V.$e"; done
echo "Hello, the new voice is ready." | ./piper/piper -m "$D/$V.onnx" -f /tmp/piper-test.wav >/dev/null 2>&1 && echo "Installed in $D (test: /tmp/piper-test.wav)"
