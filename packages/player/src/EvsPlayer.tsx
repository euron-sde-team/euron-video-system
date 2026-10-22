import { type CSSProperties, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlBar } from "./components/ControlBar";
import { CenterPlayButton, ErrorOverlay, OsdToast, ReplayOverlay, Spinner } from "./components/Overlays";
import { Watermark } from "./components/Watermark";
import { useControlsAutoHide } from "./hooks/useControlsAutoHide";
import { useHlsPlayer } from "./hooks/useHlsPlayer";
import { useInjectStyles } from "./hooks/useInjectStyles";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { canPlayNativeHls, useNativeHls, useNativeTextTracks } from "./hooks/useNativeHls";
import { usePlaybackState } from "./hooks/usePlaybackState";
import { usePlayerTracks } from "./hooks/usePlayerTracks";
import { useVttThumbnails } from "./hooks/useVttThumbnails";
import type { PlayerSource } from "./types";

export interface EvsPlayerProps {
  /** Tokenized master playlist URL, from POST /v1/videos/:id/playback-sessions. */
  manifestUrl: string;
  /** Tokenized thumbnails VTT URL (sprite previews on the seek bar). */
  thumbnailsUrl?: string;
  posterUrl?: string;
  /** Viewer identity rendered as a moving overlay. Omit for no watermark. */
  watermarkText?: string;
  autoPlay?: boolean;
  /**
   * Called when a playlist or key request is rejected (expired or revoked
   * session). Return fresh URLs and playback resumes at the same position.
   * Without it the player shows a retry prompt.
   */
  onRefreshSession?: () => Promise<PlayerSource>;
  /** CSS aspect-ratio of the frame. Default "16 / 9". Ignored in fullscreen. */
  aspectRatio?: string;
  /** Accent color for the progress bar and active controls. */
  accentColor?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Embeddable player for AES-128 HLS streams served by the EVS playback API.
 *
 * Engine: hls.js (MSE) everywhere except iPhone, where native HLS is used (see
 * canPlayNativeHls). Both load the same tokenized master; the AES key is
 * fetched by the engine from the playlist's EXT-X-KEY URI, so no key handling
 * happens in this component.
 */
export function EvsPlayer({
  manifestUrl,
  thumbnailsUrl,
  posterUrl,
  watermarkText,
  autoPlay = false,
  onRefreshSession,
  aspectRatio = "16 / 9",
  accentColor,
  className,
  style,
}: EvsPlayerProps) {
  useInjectStyles();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // The active source starts from props and is replaced by refreshed sessions.
  const [source, setSource] = useState<PlayerSource>({ manifestUrl, thumbnailsUrl });
  useEffect(() => setSource({ manifestUrl, thumbnailsUrl }), [manifestUrl, thumbnailsUrl]);

  const goNative = useMemo(() => canPlayNativeHls(), []);
  const engine = useHlsPlayer(videoRef, goNative ? null : source.manifestUrl);
  const native = useNativeHls(videoRef, goNative ? source.manifestUrl : null);
  const nativeCaptions = useNativeTextTracks(videoRef, goNative);
  const tiles = useVttThumbnails(source.thumbnailsUrl ?? null);
  const state = usePlaybackState(videoRef);
  const { textTracks, textVisible } = usePlayerTracks(engine.hls);

  const error = goNative ? native.error : engine.error;
  const isBuffering = goNative ? native.isBuffering : engine.isBuffering;
  const captionsAvailable = goNative ? nativeCaptions.available : textTracks.length > 0;
  const captionsOn = goNative ? nativeCaptions.on : textVisible;

  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [holdVisible, setHoldVisible] = useState(false);
  const [osd, setOsd] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const resumeAt = useRef<number | null>(null);
  const autoRefreshed = useRef(false);

  const osdTimer = useRef<number | null>(null);
  const showOsd = useCallback((text: string) => {
    setOsd(text);
    if (osdTimer.current !== null) window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsd(null), 700);
  }, []);

  const { visible, nudge } = useControlsAutoHide(!state.paused, state.paused || scrubbing || holdVisible);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate, engine.hls, source]);

  // Resume where the viewer was after a session refresh swapped the source.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      if (resumeAt.current !== null) {
        v.currentTime = resumeAt.current;
        resumeAt.current = null;
        void v.play().catch(() => undefined);
      } else if (autoPlay) {
        void v.play().catch(() => undefined);
      }
    };
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [autoPlay]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const refresh = useCallback(async () => {
    if (!onRefreshSession) {
      if (goNative) videoRef.current?.load();
      else engine.retry();
      return;
    }
    setRefreshing(true);
    try {
      resumeAt.current = videoRef.current?.currentTime || null;
      setSource(await onRefreshSession());
    } catch {
      showOsd("Could not refresh the session");
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshSession, goNative, engine, showOsd]);

  // An expired session refreshes itself once, silently; repeated failures surface the prompt.
  useEffect(() => {
    if (!error) {
      autoRefreshed.current = false;
      return;
    }
    if (error.isAuth && onRefreshSession && !autoRefreshed.current) {
      autoRefreshed.current = true;
      void refresh();
    }
  }, [error, onRefreshSession, refresh]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  const toggleCaptions = useCallback(() => {
    if (goNative) {
      showOsd(nativeCaptions.on ? "Subtitles off" : "Subtitles on");
      nativeCaptions.toggle();
      return;
    }
    const hls = engine.hls;
    if (!hls) return;
    if (hls.subtitleTrack >= 0) {
      hls.subtitleTrack = -1;
      showOsd("Subtitles off");
    } else if (hls.subtitleTracks.length > 0) {
      hls.subtitleTrack = 0;
      hls.subtitleDisplay = true;
      showOsd("Subtitles on");
    }
  }, [goNative, nativeCaptions, engine.hls, showOsd]);

  useKeyboardShortcuts({
    videoRef,
    containerRef,
    enabled: Boolean(engine.hls) || goNative,
    onToggleFullscreen: toggleFullscreen,
    onToggleCaptions: toggleCaptions,
    showOsd,
  });

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  // Single click toggles play; double click toggles fullscreen, or on touch
  // seeks 10s when tapping the left or right third.
  const tapRef = useRef<number | null>(null);
  const singleTimer = useRef<number | null>(null);
  const onSurfaceClick = (e: MouseEvent) => {
    const now = performance.now();
    if (tapRef.current !== null && now - tapRef.current < 300) {
      if (singleTimer.current !== null) window.clearTimeout(singleTimer.current);
      tapRef.current = null;
      const rect = containerRef.current?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left : 0;
      const w = rect?.width ?? 1;
      const v = videoRef.current;
      if (window.matchMedia("(pointer: coarse)").matches && v && (x < w / 3 || x > (w * 2) / 3)) {
        const delta = x < w / 3 ? -10 : 10;
        v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
        showOsd(`${delta > 0 ? "+" : "-"}10s`);
      } else {
        toggleFullscreen();
      }
      return;
    }
    tapRef.current = now;
    singleTimer.current = window.setTimeout(() => {
      togglePlay();
      tapRef.current = null;
    }, 260);
  };

  const rootStyle: CSSProperties = {
    ...(isFullscreen ? {} : { aspectRatio }),
    ...(accentColor ? ({ "--evs-accent": accentColor } as CSSProperties) : {}),
    ...style,
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={["evs-p-root", isFullscreen && "evs-p-fs", !visible && "evs-p-idle", className].filter(Boolean).join(" ")}
      style={rootStyle}
      onPointerMove={nudge}
      // Suppress the native context menu ("Save video as..."): a deterrent, not protection.
      onContextMenu={(e) => e.preventDefault()}
    >
      <video ref={videoRef} className="evs-p-video" poster={posterUrl} playsInline onClick={onSurfaceClick} />
      {watermarkText && <Watermark text={watermarkText} />}
      {isBuffering && !error && <Spinner />}
      {state.paused && !state.ended && !isBuffering && !error && <CenterPlayButton onClick={togglePlay} />}
      {state.ended && !error && (
        <ReplayOverlay
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            v.currentTime = 0;
            void v.play();
          }}
        />
      )}
      <OsdToast text={osd} />
      {error && <ErrorOverlay error={error} busy={refreshing} onRetry={() => void refresh()} />}
      {!error && (
        <ControlBar
          video={videoRef.current}
          hls={engine.hls}
          state={state}
          tiles={tiles}
          hidden={!(visible || state.paused)}
          playbackRate={playbackRate}
          onPlaybackRateChange={setPlaybackRate}
          captionsAvailable={captionsAvailable}
          captionsOn={captionsOn}
          onToggleCaptions={toggleCaptions}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          onScrubChange={setScrubbing}
          onHoldVisible={setHoldVisible}
        />
      )}
    </div>
  );
}
