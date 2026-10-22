import { Volume1, Volume2, VolumeX } from "lucide-react";

interface Props {
  volume: number;
  muted: boolean;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
}

/** Mute toggle plus a slider that expands on hover or focus. */
export function VolumeControl({ volume, muted, onVolumeChange, onToggleMute }: Props) {
  const effective = muted ? 0 : volume;
  const Icon = effective === 0 ? VolumeX : effective < 0.5 ? Volume1 : Volume2;
  return (
    <div className="evs-p-vol">
      <button className="evs-p-btn" onClick={onToggleMute} title={muted ? "Unmute (m)" : "Mute (m)"} aria-label="Mute">
        <Icon />
      </button>
      <div className="evs-p-vol-slider">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={effective}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
