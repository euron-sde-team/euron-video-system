import type Hls from "hls.js";
import { Check, ChevronLeft, ChevronRight, Settings } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePlayerTracks } from "../hooks/usePlayerTracks";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
type View = "root" | "quality" | "speed" | "captions";

interface Props {
  hls: Hls | null;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  onOpenChange: (open: boolean) => void;
}

/** Quality / speed / subtitles menu. Quality and subtitles apply to the hls.js engine. */
export function SettingsMenu({ hls, playbackRate, onPlaybackRateChange, onOpenChange }: Props) {
  const [open, setOpenState] = useState(false);
  const [view, setView] = useState<View>("root");
  const rootRef = useRef<HTMLDivElement>(null);
  const { qualities, abrEnabled, textTracks, textVisible } = usePlayerTracks(hls);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange(next);
    if (next) setView("root");
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenState(false);
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  const activeHeight = qualities.find((q) => q.active)?.height ?? null;
  const activeText = textTracks.find((t) => t.active);
  const qualityValue = abrEnabled ? `Auto${activeHeight ? ` (${activeHeight}p)` : ""}` : activeHeight ? `${activeHeight}p` : "Auto";

  const pick = (fn: () => void) => () => {
    fn();
    setView("root");
  };

  return (
    <div ref={rootRef} className="evs-p-menu-wrap">
      <button className={`evs-p-btn${open ? " evs-p-on" : ""}`} onClick={() => setOpen(!open)} title="Settings" aria-label="Settings" aria-expanded={open}>
        <Settings />
      </button>
      {open && (
        <div className="evs-p-menu" role="menu">
          {view === "root" && (
            <>
              <Row label="Quality" value={qualityValue} onClick={() => setView("quality")} disabled={qualities.length === 0} />
              <Row label="Playback speed" value={playbackRate === 1 ? "Normal" : `${playbackRate}x`} onClick={() => setView("speed")} />
              <Row
                label="Subtitles"
                value={textVisible && activeText ? activeText.label : "Off"}
                onClick={() => setView("captions")}
                disabled={textTracks.length === 0}
              />
            </>
          )}
          {view === "quality" && (
            <Submenu title="Quality" onBack={() => setView("root")}>
              <Option selected={abrEnabled} onClick={pick(() => hls && (hls.currentLevel = -1))}>
                Auto{abrEnabled && activeHeight ? ` (${activeHeight}p)` : ""}
              </Option>
              {qualities.map((q) => (
                <Option key={q.height} selected={!abrEnabled && q.active} onClick={pick(() => hls && (hls.currentLevel = q.levelIndex))}>
                  {q.label}
                </Option>
              ))}
            </Submenu>
          )}
          {view === "speed" && (
            <Submenu title="Playback speed" onBack={() => setView("root")}>
              {SPEEDS.map((rate) => (
                <Option key={rate} selected={playbackRate === rate} onClick={pick(() => onPlaybackRateChange(rate))}>
                  {rate === 1 ? "Normal" : `${rate}x`}
                </Option>
              ))}
            </Submenu>
          )}
          {view === "captions" && (
            <Submenu title="Subtitles" onBack={() => setView("root")}>
              <Option selected={!textVisible} onClick={pick(() => hls && (hls.subtitleTrack = -1))}>
                Off
              </Option>
              {textTracks.map((t) => (
                <Option
                  key={t.id}
                  selected={textVisible && t.active}
                  onClick={pick(() => {
                    if (!hls) return;
                    hls.subtitleTrack = t.id;
                    hls.subtitleDisplay = true;
                  })}
                >
                  {t.label}
                </Option>
              ))}
            </Submenu>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, onClick, disabled }: { label: string; value: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="evs-p-mrow" onClick={onClick} disabled={disabled} role="menuitem">
      <span>{label}</span>
      <span className="evs-p-mval">
        {value} <ChevronRight />
      </span>
    </button>
  );
}

function Option({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className="evs-p-mrow evs-p-mopt" onClick={onClick} role="menuitemradio" aria-checked={selected}>
      <Check className={`evs-p-check${selected ? " evs-p-sel" : ""}`} />
      <span>{children}</span>
    </button>
  );
}

function Submenu({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div>
      <button className="evs-p-mrow evs-p-mhead" onClick={onBack}>
        <ChevronLeft />
        {title}
      </button>
      <div className="evs-p-mlist">{children}</div>
    </div>
  );
}
