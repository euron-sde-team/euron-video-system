import { AlertTriangle, Play, RotateCcw } from "lucide-react";
import type { PlayerError } from "../types";

export function Spinner() {
  return (
    <div className="evs-p-overlay evs-p-passive">
      <div className="evs-p-spin" />
    </div>
  );
}

export function CenterPlayButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="evs-p-overlay evs-p-passive">
      <button className="evs-p-big" style={{ pointerEvents: "auto" }} onClick={onClick} aria-label="Play">
        <Play fill="currentColor" style={{ marginLeft: 4 }} />
      </button>
    </div>
  );
}

export function ReplayOverlay({ onClick }: { onClick: () => void }) {
  return (
    <div className="evs-p-overlay evs-p-dim">
      <button className="evs-p-big" onClick={onClick} aria-label="Replay">
        <RotateCcw />
      </button>
    </div>
  );
}

export function ErrorOverlay({ error, busy, onRetry }: { error: PlayerError; busy: boolean; onRetry: () => void }) {
  return (
    <div className="evs-p-overlay evs-p-err" role="alert">
      <AlertTriangle style={{ width: 36, height: 36, color: "#f87171" }} />
      <p className="evs-p-errmsg">{error.message}</p>
      {error.code != null && <p className="evs-p-errcode">Player error {error.code}</p>}
      <button className="evs-p-retry" onClick={onRetry} disabled={busy}>
        <RotateCcw /> {busy ? "Reconnecting" : "Retry"}
      </button>
    </div>
  );
}

export function OsdToast({ text }: { text: string | null }) {
  return text ? <div className="evs-p-osd">{text}</div> : null;
}
