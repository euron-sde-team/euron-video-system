import { type RefObject, useEffect } from "react";

interface Options {
  videoRef: RefObject<HTMLVideoElement>;
  containerRef: RefObject<HTMLElement>;
  enabled: boolean;
  onToggleFullscreen: () => void;
  onToggleCaptions: () => void;
  showOsd: (text: string) => void;
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * Familiar media shortcuts: space/k play, j/l and arrows seek, up/down volume,
 * m mute, f fullscreen, c captions, ,/. frame step, 0-9 jump to tenths.
 *
 * Active only while the player has focus or the pointer is over it, so an
 * embedded player never hijacks keys from the surrounding page (two players on
 * one page do not fight either).
 */
export function useKeyboardShortcuts({
  videoRef,
  containerRef,
  enabled,
  onToggleFullscreen,
  onToggleCaptions,
  showOsd,
}: Options) {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const root = containerRef.current;
      const video = videoRef.current;
      if (!root || !video) return;
      const engaged = root.contains(document.activeElement) || root.matches(":hover") || document.fullscreenElement === root;
      if (!engaged) return;

      const seekBy = (delta: number) => {
        video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
        showOsd(`${delta > 0 ? "+" : "-"}${Math.abs(delta)}s`);
      };
      const setVolume = (v: number) => {
        video.muted = false;
        video.volume = Math.max(0, Math.min(1, v));
        showOsd(`Volume ${Math.round(video.volume * 100)}%`);
      };

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          if (video.paused) {
            void video.play();
            showOsd("Play");
          } else {
            video.pause();
            showOsd("Paused");
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(5);
          break;
        case "j":
          seekBy(-10);
          break;
        case "l":
          seekBy(10);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(video.volume + 0.05);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(video.volume - 0.05);
          break;
        case "m":
          video.muted = !video.muted;
          showOsd(video.muted ? "Muted" : "Unmuted");
          break;
        case "f":
          onToggleFullscreen();
          break;
        case "c":
          onToggleCaptions();
          break;
        case ",":
          video.pause();
          video.currentTime = Math.max(0, video.currentTime - 1 / 30);
          break;
        case ".":
          video.pause();
          video.currentTime += 1 / 30;
          break;
        default:
          if (/^[0-9]$/.test(e.key) && video.duration) {
            video.currentTime = (Number(e.key) / 10) * video.duration;
            showOsd(`${Number(e.key) * 10}%`);
          }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, videoRef, containerRef, onToggleFullscreen, onToggleCaptions, showOsd]);
}
