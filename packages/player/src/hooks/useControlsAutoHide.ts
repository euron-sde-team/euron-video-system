import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Controls visibility: shown on pointer movement, hidden after `idleMs` while
 * playing. Always visible when paused or when `keepVisible` (a menu is open,
 * the pointer is over the bar, the user is scrubbing).
 */
export function useControlsAutoHide(playing: boolean, keepVisible: boolean, idleMs = 3000) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<number | null>(null);

  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const nudge = useCallback(() => {
    setVisible(true);
    clear();
    if (playing && !keepVisible) timerRef.current = window.setTimeout(() => setVisible(false), idleMs);
  }, [playing, keepVisible, idleMs]);

  useEffect(() => {
    if (!playing || keepVisible) {
      setVisible(true);
      clear();
      return;
    }
    nudge();
    return clear;
  }, [playing, keepVisible, nudge]);

  return { visible, nudge };
}
