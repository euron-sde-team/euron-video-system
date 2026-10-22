import Hls from "hls.js";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { PlayerError } from "../types";

interface UseHlsPlayerResult {
  hls: Hls | null;
  isBuffering: boolean;
  error: PlayerError | null;
  retry: () => void;
}

/**
 * Owns the hls.js lifecycle for one <video> on MSE browsers. hls.js plays the
 * AES-128 MPEG-TS tree and decrypts each segment with the key fetched from the
 * playlist's EXT-X-KEY URI (the token is already baked into that URI by the
 * API's per-request playlist rewrite). StrictMode-safe: each effect run owns
 * its own Hls instance and destroys it on cleanup.
 */
export function useHlsPlayer(videoRef: RefObject<HTMLVideoElement>, url: string | null): UseHlsPlayerResult {
  const [hls, setHls] = useState<Hls | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState<PlayerError | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const recoveredRef = useRef(false);

  const retry = useCallback(() => {
    setError(null);
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;

    setError(null);
    setIsBuffering(true);
    recoveredRef.current = false;

    if (!Hls.isSupported()) {
      setError({ message: "This browser does not support the required media APIs.", isAuth: false });
      return;
    }

    // Tuned for weak and variable networks: start low and ramp, never fetch a
    // rung larger than the on-screen player, buffer further ahead, bound memory,
    // and stay patient on slow segment loads.
    const instance = new Hls({
      enableWorker: true,
      // Assume a low pipe until measured so the first segment opens at a low
      // rung and playback starts fast; ABR ramps up as throughput is measured.
      // (startLevel: 0 would be wrong here: the master lists the top rung first.)
      abrEwmaDefaultEstimate: 300_000,
      capLevelToPlayerSize: true,
      // Segments are immutable and edge-cached, so a deep forward buffer is cheap.
      maxBufferLength: 60,
      // Evict played media older than 90s to cap memory on low-RAM devices.
      backBufferLength: 90,
      lowLatencyMode: false,
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 20_000,
          maxLoadTimeMs: 120_000,
          timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: { maxNumRetry: 8, retryDelayMs: 2000, maxRetryDelayMs: 15_000, backoff: "linear" },
        },
      },
    });

    const onWaiting = () => setIsBuffering(true);
    const onReady = () => setIsBuffering(false);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onReady);
    video.addEventListener("canplay", onReady);

    instance.on(Hls.Events.MEDIA_ATTACHED, () => instance.loadSource(url));
    instance.on(Hls.Events.MANIFEST_PARSED, () => setIsBuffering(false));
    instance.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const status = data.response?.code;
      // A 401/403 on a playlist or the key: the playback session expired or was revoked.
      const isAuth = status === 401 || status === 403;
      // One in-place media-error recovery (buffer/append glitch) before surfacing.
      if (!isAuth && data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredRef.current) {
        recoveredRef.current = true;
        instance.recoverMediaError();
        return;
      }
      setError({
        code: status,
        message: isAuth
          ? "The playback session expired or was revoked."
          : "Playback failed. The video may still be processing or unavailable.",
        isAuth,
      });
    });

    instance.attachMedia(video);
    setHls(instance);

    return () => {
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("canplay", onReady);
      setHls(null);
      instance.destroy();
      setIsBuffering(false);
      setError(null);
    };
  }, [url, retryNonce, videoRef]);

  return { hls, isBuffering, error, retry };
}
