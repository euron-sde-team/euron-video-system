#!/usr/bin/env bash
# End-to-end test against the full local stack (Floci overlay).
#
#   make e2e                      # brings the stack up, runs this, tears down
#   EVS_E2E_KEEP=1 make e2e       # leave the stack running afterwards
#
# Flow: root key via CLI -> synthetic 6s clip -> create/upload/complete
#       -> poll to ready (10 min) -> mint playback session, then assert:
#   1. master playlist: 200 WITH the token
#   2. master playlist: 401 WITHOUT a token
#   3. the EXT-X-KEY URI from a variant playlist returns exactly 16 bytes
#   4. after revoking the session, the key endpoint returns 401
# Exits non-zero on the first failed assertion.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/compose/compose.yaml" -f "$ROOT/deploy/compose/compose.floci.yaml")
BASE="${EVS_API:-http://localhost:8080}"
PREFIX="${EVS_API_PREFIX:-/v1}"
API="$BASE$PREFIX"
TMP="$(mktemp -d)"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

E2E_KEY_ID=""
cleanup() {
  local code=$?
  rm -rf "$TMP"
  # Never leave the throwaway root key behind on a stack that stays up. A key
  # cannot revoke itself through the API, so revoke it with the CLI.
  if [[ -n "$E2E_KEY_ID" && "${EVS_E2E_KEEP:-0}" == "1" ]]; then
    "${COMPOSE[@]}" run --rm -T migrate pnpm --silent evs keys:revoke "$E2E_KEY_ID" >/dev/null 2>&1 \
      && echo "revoked e2e key $E2E_KEY_ID" || echo "warning: could not revoke e2e key $E2E_KEY_ID" >&2
  fi
  if [[ "${EVS_E2E_KEEP:-0}" != "1" && "${EVS_E2E_TEARDOWN:-1}" == "1" ]]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ $code -ne 0 ]]; then
    echo "--- last api/worker logs ---" >&2
    "${COMPOSE[@]}" logs --tail 60 api worker 2>/dev/null >&2 || true
  fi
  exit $code
}
trap cleanup EXIT

for bin in curl jq ffmpeg ffprobe openssl xxd docker; do command -v "$bin" >/dev/null || fail "$bin is required"; done

echo "waiting for the API"
for _ in $(seq 1 120); do curl -fsS "$BASE/readyz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$BASE/readyz" >/dev/null || fail "API never became ready"

echo "creating a root API key via the CLI"
out="$("${COMPOSE[@]}" run --rm -T migrate pnpm --silent evs keys:create --name e2e-root --scopes '*')"
EVS_API_KEY="$(grep -oE 'evs_[A-Za-z0-9_-]+' <<<"$out" | head -1)"
[[ -n "$EVS_API_KEY" ]] || fail "could not parse an API key from the CLI output"
export EVS_API_KEY
E2E_KEY_ID="$(curl -fsS "$BASE/v1/me" -H "Authorization: Bearer $EVS_API_KEY" | jq -r '.apiKey.id')"

echo "generating a 6s test clip"
CLIP="$TMP/e2e.mp4"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=6" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "$CLIP"

api() { # method path [json]
  curl -fsS -X "$1" "$API$2" -H "Authorization: Bearer $EVS_API_KEY" \
    -H "Content-Type: application/json" ${3:+--data "$3"} | jq '.'
}

echo "create -> upload -> complete"
created="$(api POST /videos '{"filename":"e2e.mp4","title":"e2e"}')"
id="$(jq -r '.video.id' <<<"$created")"
[[ -n "$id" && "$id" != null ]] || fail "create returned no id: $created"
form=()
while IFS=$'\t' read -r k v; do form+=(-F "$k=$v"); done < <(jq -r '.upload.fields | to_entries[] | [.key, .value] | @tsv' <<<"$created")
curl -fsS "${form[@]}" -F "Content-Type=video/mp4" -F "file=@$CLIP;type=video/mp4" "$(jq -r '.upload.url' <<<"$created")" -o /dev/null \
  || fail "presigned POST to storage failed"
api POST "/videos/$id/complete" >/dev/null || fail "complete failed"
pass "uploaded video $id"

echo "polling until ready (timeout 10 min)"
deadline=$((SECONDS + 600))
status=""
while (( SECONDS < deadline )); do
  status="$(api GET "/videos/$id" | jq -r '.status')"
  [[ "$status" == ready ]] && break
  [[ "$status" == failed || "$status" == cancelled ]] && fail "video ended $status"
  sleep 5
done
[[ "$status" == ready ]] || fail "timed out (last status: $status)"
pass "video ready"

session="$(api POST "/videos/$id/playback-sessions" '{"viewerId":"e2e-viewer"}')"
token="$(jq -r '.token' <<<"$session")"
sid="$(jq -r '.sessionId' <<<"$session")"
manifest="$(jq -r '.manifestUrl' <<<"$session")"
[[ -n "$token" && "$token" != null && -n "$manifest" ]] || fail "unexpected session response: $session"
bare="${manifest%%\?*}"

code="$(curl -s -o "$TMP/master.m3u8" -w '%{http_code}' "$manifest")"
if ! { [[ "$code" == 200 ]] && grep -q '#EXTM3U' "$TMP/master.m3u8"; }; then fail "master with token: HTTP $code"; fi
pass "master playlist 200 with token"

code="$(curl -s -o /dev/null -w '%{http_code}' "$bare")"
[[ "$code" == 401 ]] || fail "master without token: expected 401, got $code"
pass "master playlist 401 without token"

variant="$(grep -v '^#' "$TMP/master.m3u8" | grep -m1 .)"
[[ "$variant" == http* ]] || variant="$(dirname "$bare")/$variant"
curl -fsS -o "$TMP/variant.m3u8" "$variant" || fail "variant playlist fetch failed"
key_url="$(grep -m1 '#EXT-X-KEY' "$TMP/variant.m3u8" | sed -E 's/.*URI="([^"]+)".*/\1/')"
[[ -n "$key_url" ]] || fail "variant playlist has no EXT-X-KEY"
curl -fsS -o "$TMP/key.bin" "$key_url" || fail "key fetch failed"
size="$(wc -c <"$TMP/key.bin" | tr -d ' ')"
[[ "$size" == 16 ]] || fail "key endpoint returned $size bytes, expected 16"
pass "key endpoint returned exactly 16 bytes"

# ── Play it like a player: the delivered key must decrypt the delivered segment ──
# Follow the first segment URI exactly as the API rewrote it (the delivery
# driver's signed / tokenized URL), then decrypt with the key and the IV the
# playlist advertises. Valid MPEG-TS out proves the whole chain: worker
# encryption, KMS-wrapped key storage, unwrap on delivery, playlist rewrite.
segment_url="$(grep -v '^#' "$TMP/variant.m3u8" | grep -m1 .)"
[[ "$segment_url" == http* ]] || fail "segment URI is not absolute: $segment_url"
curl -fsS -o "$TMP/seg0.ts" "$segment_url" || fail "segment fetch failed"
[[ "$(head -c1 "$TMP/seg0.ts" | xxd -p)" != "47" ]] || fail "segment is plain MPEG-TS: not encrypted"
pass "segment delivered encrypted"

iv_hex="$(grep -m1 '#EXT-X-KEY' "$TMP/variant.m3u8" | sed -nE 's/.*IV=0x([0-9A-Fa-f]{32}).*/\1/p')"
if [[ -z "$iv_hex" ]]; then # RFC 8216: no IV attribute => the media sequence number
  seq="$(sed -nE 's/^#EXT-X-MEDIA-SEQUENCE:([0-9]+).*/\1/p' "$TMP/variant.m3u8")"
  iv_hex="$(printf '%032x' "${seq:-0}")"
fi
openssl enc -d -aes-128-cbc -K "$(xxd -p "$TMP/key.bin" | tr -d '\n')" -iv "$iv_hex" \
  -in "$TMP/seg0.ts" -out "$TMP/seg0.clear.ts" 2>/dev/null || fail "segment did not decrypt with the delivered key"
clear_size="$(wc -c <"$TMP/seg0.clear.ts" | tr -d ' ')"
(( clear_size > 0 && clear_size % 188 == 0 )) || fail "decrypted segment is not whole 188-byte TS packets ($clear_size bytes)"
for off in 0 188 376; do
  [[ "$(dd if="$TMP/seg0.clear.ts" bs=1 skip="$off" count=1 2>/dev/null | xxd -p)" == "47" ]] \
    || fail "decrypted packet at offset $off has no 0x47 sync byte"
done
ffprobe -v error -show_entries stream=codec_name -of csv=p=0 "$TMP/seg0.clear.ts" | grep -q h264 \
  || fail "decrypted segment has no H.264 stream"
pass "delivered key decrypts the delivered segment into valid H.264 MPEG-TS"

thumbs="$(jq -r '.thumbnailsUrl // empty' <<<"$session")"
if [[ -n "$thumbs" ]]; then
  code="$(curl -s -o "$TMP/thumbs.vtt" -w '%{http_code}' "$thumbs")"
  if ! { [[ "$code" == 200 ]] && grep -q '#xywh=' "$TMP/thumbs.vtt"; }; then fail "thumbnails VTT: got $code or no sprite cues"; fi
  pass "thumbnail sprite VTT served with #xywh cues"
fi

curl -fsS -X DELETE "$API/playback-sessions/$sid" -H "Authorization: Bearer $EVS_API_KEY" -o /dev/null \
  || fail "revoke failed"
# Session liveness is cached per API process for a few seconds, so allow
# a short convergence window across cluster workers.
code=""
for _ in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$key_url")"
  [[ "$code" == 401 ]] && break
  sleep 1
done
[[ "$code" == 401 ]] || fail "key after revoke: expected 401, got $code"
pass "revoked session rejected with 401"

echo "e2e: all assertions passed"
