/**
 * Pure player logic, kept free of React and DOM globals so it is unit-testable
 * in plain Node (see test/).
 */

export interface LevelLike {
  height?: number;
  bitrate?: number;
}

export interface QualityOption {
  height: number;
  label: string;
  /** Index into hls.levels; hls.currentLevel = levelIndex locks this rung. */
  levelIndex: number;
  active: boolean;
}

/**
 * One option per distinct height, keeping the highest-bitrate level for each
 * (a ladder can carry two levels at one height, e.g. differing codecs), sorted
 * high to low. `currentLevel` is hls.currentLevel (-1 = auto / unknown).
 */
export function buildQualityOptions(levels: readonly LevelLike[], currentLevel: number): QualityOption[] {
  const activeHeight = currentLevel >= 0 ? (levels[currentLevel]?.height ?? null) : null;
  const byHeight = new Map<number, QualityOption>();
  levels.forEach((lvl, i) => {
    if (!lvl.height) return;
    const existing = byHeight.get(lvl.height);
    if (!existing || (lvl.bitrate ?? 0) > (levels[existing.levelIndex]?.bitrate ?? 0)) {
      byHeight.set(lvl.height, { height: lvl.height, label: `${lvl.height}p`, levelIndex: i, active: lvl.height === activeHeight });
    }
  });
  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

/**
 * Engine selector: native <video src=m3u8> ONLY on iPhone/iPod that report HLS
 * support; hls.js (MSE) everywhere else.
 *
 * Desktop Safari and iPadOS deliberately use hls.js: it feeds an in-memory
 * MediaSource blob, so the browser exposes no saveable media URL, whereas
 * native HLS hands Safari a playlist the viewer could download and replay.
 * iPhone is matched explicitly because hls.js's Managed Media Source path is
 * unreliable there (every iOS browser is WebKit, so CriOS/FxiOS stay native
 * too). iPadOS reports a desktop UA and has full MSE.
 */
export function shouldUseNativeHls(userAgent: string, canPlayType: (mime: string) => string): boolean {
  if (!/iPhone|iPod/.test(userAgent)) return false;
  return canPlayType("application/vnd.apple.mpegurl") !== "";
}
