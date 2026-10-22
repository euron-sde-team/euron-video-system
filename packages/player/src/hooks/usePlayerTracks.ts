import Hls from "hls.js";
import { useEffect, useState } from "react";
import { buildQualityOptions, type QualityOption } from "../lib";

export type { QualityOption } from "../lib";

export interface TextTrackOption {
  /** Index into hls.subtitleTracks. */
  id: number;
  label: string;
  language?: string;
  active: boolean;
}

export interface TrackInfo {
  qualities: QualityOption[];
  abrEnabled: boolean;
  textTracks: TextTrackOption[];
  textVisible: boolean;
}

/** Quality and caption tracks from hls.js, refreshed on its level and subtitle events. */
export function usePlayerTracks(hls: Hls | null): TrackInfo {
  const [, setNonce] = useState(0);

  useEffect(() => {
    if (!hls) return;
    const bump = () => setNonce((n) => n + 1);
    const events = [
      Hls.Events.MANIFEST_PARSED,
      Hls.Events.LEVEL_SWITCHED,
      Hls.Events.LEVEL_LOADED,
      Hls.Events.SUBTITLE_TRACKS_UPDATED,
      Hls.Events.SUBTITLE_TRACK_SWITCH,
    ] as const;
    events.forEach((e) => hls.on(e, bump));
    bump();
    return () => events.forEach((e) => hls.off(e, bump));
  }, [hls]);

  if (!hls) return { qualities: [], abrEnabled: true, textTracks: [], textVisible: false };

  const subs = hls.subtitleTracks ?? [];
  return {
    qualities: buildQualityOptions(hls.levels ?? [], hls.currentLevel),
    abrEnabled: hls.autoLevelEnabled,
    textTracks: subs.map((s, i) => ({
      id: i,
      label: s.name || (s.lang ? s.lang.toUpperCase() : "") || "Subtitles",
      language: s.lang,
      active: i === hls.subtitleTrack,
    })),
    textVisible: hls.subtitleTrack >= 0,
  };
}
