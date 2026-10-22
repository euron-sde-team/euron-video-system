import { type RefObject, useCallback, useEffect, useState } from "react";
import { shouldUseNativeHls } from "../lib";
import type { PlayerError } from "../types";

/** True on iPhone/iPod with native HLS support (see shouldUseNativeHls). */
export function canPlayNativeHls(): boolean {
  if (typeof navigator === "undefined" || typeof document === "undefined") return false;
  const probe = document.createElement("video");
  return shouldUseNativeHls(navigator.userAgent, (m) => probe.canPlayType(m));
}

function nativeErrorMessage(code?: number): string {
  if (code === 2) return "A network error interrupted playback (the session may have expired).";
  if (code === 3) return "The video could not be decoded.";
  if (code === 4) return "The video could not be loaded (expired session or blocked request).";
  return "Playback failed. The video may still be processing or unavailable.";
}

/** Drive a native-HLS <video> from `url` (already tokenized). */
export function useNativeHls(
  videoRef: RefObject<HTMLVideoElement>,
  url: string | null
): { isBuffering: boolean; error: PlayerError | null } {
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState<PlayerError | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    setError(null);
    setIsBuffering(true);

    const onError = () => {
      const code = video.error?.code;
      // Native playback cannot see HTTP status codes. A network or
      // src-not-supported failure on a token-gated playlist is almost always an
      // expired or revoked session, so offer a session refresh.
      setError({ code, message: nativeErrorMessage(code), isAuth: code === 2 || code === 4 });
      setIsBuffering(false);
    };
    const onWaiting = () => setIsBuffering(true);
    const onReady = () => setIsBuffering(false);

    video.addEventListener("error", onError);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onReady);
    video.addEventListener("canplay", onReady);
    video.src = url;

    return () => {
      video.removeEventListener("error", onError);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeAttribute("src");
      video.load(); // detach so the next mount starts clean
      setIsBuffering(false);
      setError(null);
    };
  }, [url, videoRef]);

  return { isBuffering, error };
}

const isCaptionTrack = (t: TextTrack | undefined): t is TextTrack =>
  !!t && (t.kind === "subtitles" || t.kind === "captions");

/**
 * Captions on the native path. The master's EXT-X-MEDIA SUBTITLES rendition
 * surfaces as a <video> textTrack; toggling its `mode` shows or hides it.
 */
export function useNativeTextTracks(
  videoRef: RefObject<HTMLVideoElement>,
  enabled: boolean
): { available: boolean; on: boolean; toggle: () => void } {
  const [available, setAvailable] = useState(false);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled) {
      setAvailable(false);
      setOn(false);
      return;
    }
    const tracks = video.textTracks;
    const sync = () => {
      let any = false;
      let showing = false;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (isCaptionTrack(t)) {
          any = true;
          if (t.mode === "showing") showing = true;
        }
      }
      setAvailable(any);
      setOn(showing);
    };
    sync();
    tracks.addEventListener("addtrack", sync);
    tracks.addEventListener("removetrack", sync);
    tracks.addEventListener("change", sync);
    return () => {
      tracks.removeEventListener("addtrack", sync);
      tracks.removeEventListener("removetrack", sync);
      tracks.removeEventListener("change", sync);
    };
  }, [videoRef, enabled]);

  const toggle = useCallback(() => {
    const tracks = videoRef.current?.textTracks;
    if (!tracks) return;
    let target: TextTrack | null = null;
    for (let i = 0; i < tracks.length && !target; i++) {
      const t = tracks[i];
      if (isCaptionTrack(t)) target = t;
    }
    if (!target) return;
    target.mode = target.mode === "showing" ? "disabled" : "showing";
    setOn(target.mode === "showing");
  }, [videoRef]);

  return { available, on, toggle };
}
