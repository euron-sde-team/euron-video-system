#!/usr/bin/env bash
# Fetch a Creative Commons sample video into samples/ for the demo.
#
#   scripts/demo/fetch-sample.sh            # Big Buck Bunny (CC BY 3.0), 10 s 1080p clip, ~30 MB
#   scripts/demo/fetch-sample.sh --synthetic # generate a 60s test pattern with ffmpeg (offline)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$ROOT/samples"
mkdir -p "$DIR"

synthetic() {
  command -v ffmpeg >/dev/null || { echo "ffmpeg is required for --synthetic" >&2; exit 1; }
  local out="$DIR/test-pattern-1080p.mp4"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=60" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=60" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "$out"
  echo "$out"
}

if [[ "${1:-}" == "--synthetic" ]]; then
  synthetic
  exit 0
fi

OUT="$DIR/big-buck-bunny-1080p.mp4"
# Public test-media mirror of the Blender Foundation's open movie.
URL="${SAMPLE_URL:-https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4}"

if [[ ! -s "$OUT" ]]; then
  echo "downloading sample from $URL" >&2
  if ! curl -fL --retry 3 --progress-bar -o "$OUT.part" "$URL"; then
    rm -f "$OUT.part"
    echo "download failed; falling back to a synthetic test pattern" >&2
    synthetic
    exit 0
  fi
  mv "$OUT.part" "$OUT"
fi

cat >&2 <<'ATTR'
Sample: "Big Buck Bunny" (c) copyright 2008, Blender Foundation | www.bigbuckbunny.org
License: Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/)
ATTR
echo "$OUT"
