#!/usr/bin/env bash
# Upload a video end to end through the public API, exactly as an integrator would:
#   create -> presigned POST straight to object storage -> complete
#   -> poll until ready -> mint a playback session -> print where to watch it.
#
#   EVS_API_KEY=evs_... scripts/demo/upload.sh samples/big-buck-bunny-1080p.mp4 ["Title"]
#
# Env: EVS_API (default http://localhost:8080), EVS_API_PREFIX (default /v1),
#      EVS_CONSOLE (default http://localhost:3000), EVS_VIEWER (default demo-viewer)
set -euo pipefail

FILE="${1:?usage: upload.sh <video-file> [title]}"
TITLE="${2:-$(basename "$FILE")}"
API="${EVS_API:-http://localhost:8080}${EVS_API_PREFIX:-/v1}"
CONSOLE="${EVS_CONSOLE:-http://localhost:3000}"
KEY="${EVS_API_KEY:?set EVS_API_KEY (create one with: make key)}"
VIEWER="${EVS_VIEWER:-demo-viewer}"

for bin in curl jq; do command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 1; }; done
[[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 1; }

api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  curl -fsS -X "$method" "$API$path" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    ${body:+--data "$body"} | jq '.'
}

mime="video/mp4"
lower="$(tr '[:upper:]' '[:lower:]' <<<"$FILE")"
case "$lower" in
  *.mov) mime="video/quicktime" ;; *.mkv) mime="video/x-matroska" ;; *.webm) mime="video/webm" ;;
esac

echo "1/5 creating video"
created="$(api POST /videos "$(jq -n --arg f "$(basename "$FILE")" --arg t "$TITLE" '{filename:$f,title:$t}')")"
id="$(jq -r '.video.id' <<<"$created")"
url="$(jq -r '.upload.url' <<<"$created")"
echo "    video $id"

echo "2/5 uploading $(du -h "$FILE" | cut -f1) directly to storage (presigned POST)"
form=()
while IFS=$'\t' read -r k v; do form+=(-F "$k=$v"); done < <(jq -r '.upload.fields | to_entries[] | [.key, .value] | @tsv' <<<"$created")
curl -fsS "${form[@]}" -F "Content-Type=$mime" -F "file=@$FILE;type=$mime" "$url" -o /dev/null

echo "3/5 completing upload (server verifies the object with HeadObject)"
api POST "/videos/$id/complete" >/dev/null

echo "4/5 waiting for transcode"
for _ in $(seq 1 720); do
  v="$(api GET "/videos/$id")"
  status="$(jq -r '.status' <<<"$v")"
  printf "\r    %-10s stage=%-16s progress=%s%%   " "$status" "$(jq -r '.stage // "-"' <<<"$v")" "$(jq -r '.progress // 0' <<<"$v")"
  case "$status" in
    ready) echo; break ;;
    failed|cancelled) echo; echo "transcode $status: $(jq -r '.error // ""' <<<"$v")" >&2; exit 1 ;;
  esac
  sleep 5
done
[[ "$status" == "ready" ]] || { echo; echo "timed out waiting for ready" >&2; exit 1; }

echo "5/5 minting a playback session for viewer '$VIEWER'"
session="$(api POST "/videos/$id/playback-sessions" "$(jq -n --arg v "$VIEWER" '{viewerId:$v}')")"
echo
echo "  manifest : $(jq -r '.manifestUrl' <<<"$session")"
echo "  expires  : $(jq -r '.expiresAt // empty' <<<"$session")"
echo "  console  : $CONSOLE/videos/$id"
