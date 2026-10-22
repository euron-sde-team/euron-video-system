#!/usr/bin/env bash
# One-command demo: create an API key (unless EVS_API_KEY is set), fetch the
# sample video, and push it through the full pipeline.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/compose/compose.yaml" -f "$ROOT/deploy/compose/compose.floci.yaml")

if [[ -z "${EVS_API_KEY:-}" ]]; then
  echo "creating a demo API key"
  out="$("${COMPOSE[@]}" run --rm -T migrate pnpm --silent evs keys:create --name demo --scopes '*')"
  EVS_API_KEY="$(grep -oE 'evs_[A-Za-z0-9_-]+' <<<"$out" | head -1)"
  [[ -n "$EVS_API_KEY" ]] || { echo "could not parse key from CLI output:" >&2; echo "$out" >&2; exit 1; }
  export EVS_API_KEY
  echo "  key: $EVS_API_KEY   (shown once; paste it into the console Settings screen)"
fi

sample="$("$ROOT/scripts/demo/fetch-sample.sh" "${SAMPLE_MODE:-}")"
"$ROOT/scripts/demo/upload.sh" "$sample" "Big Buck Bunny"
