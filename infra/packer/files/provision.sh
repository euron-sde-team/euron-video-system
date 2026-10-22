#!/bin/bash
# Provision the worker AMI (runs as root inside the Packer build instance).
set -euo pipefail

dnf -y update
dnf -y install jq tar xz git cmake gcc-c++ make amazon-cloudwatch-agent

# Node.js (NodeSource repo for the pinned major).
curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
dnf -y install nodejs

# FFmpeg: static arm64 build (libx264, AAC, HLS muxer, AES-128 segment encryption).
curl -fsSL -o /tmp/ffmpeg.tar.xz \
  "https://johnvansickle.com/ffmpeg/releases/ffmpeg-${FFMPEG_VERSION}-arm64-static.tar.xz" \
  || curl -fsSL -o /tmp/ffmpeg.tar.xz "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
tar -xJf /tmp/ffmpeg.tar.xz -C /tmp
install -m 0755 /tmp/ffmpeg-*-static/ffmpeg /tmp/ffmpeg-*-static/ffprobe /usr/local/bin/
ffmpeg -hide_banner -version | head -1

# whisper.cpp at a pinned tag + model. GGML_NATIVE=OFF: one AMI must run on
# every Graviton generation in the instance ladder (c6g and c7g differ).
git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /tmp/whisper
cmake -S /tmp/whisper -B /tmp/whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF
cmake --build /tmp/whisper/build -j"$(nproc)" --target whisper-cli
install -d /opt/whisper.cpp /opt/models
install -m 0755 /tmp/whisper/build/bin/whisper-cli /opt/whisper.cpp/whisper-cli
curl -fsSL -o "/opt/models/ggml-${WHISPER_MODEL}.bin" \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"

# Service account + app.
useradd --system --home-dir /var/lib/evs --shell /sbin/nologin evs
install -d -o evs -g evs -m 0750 /var/lib/evs /var/lib/evs/work /var/log/evs
cat > /etc/sudoers.d/evs-worker <<'SUDO'
# Idle self-termination: the evs user may power the host off, and nothing else.
evs ALL=(root) NOPASSWD: /usr/sbin/shutdown -h now
SUDO
chmod 0440 /etc/sudoers.d/evs-worker
visudo -cf /etc/sudoers.d/evs-worker
install -d -o root -g root -m 0755 /opt/evs/worker
cp -r /tmp/evs-build/index.js* /opt/evs/worker/
install -m 0644 /tmp/evs-build/evs-worker.service /etc/systemd/system/evs-worker.service
sed -i "s|@WHISPER_MODEL@|/opt/models/ggml-${WHISPER_MODEL}.bin|" /etc/systemd/system/evs-worker.service
systemctl daemon-reload
# Enabled by user data after the env file exists, not at image boot.
systemctl disable evs-worker.service || true

# Trim the image.
dnf -y remove gcc-c++ cmake git || true
dnf clean all
rm -rf /tmp/whisper /tmp/ffmpeg* /tmp/evs-build /var/cache/dnf
