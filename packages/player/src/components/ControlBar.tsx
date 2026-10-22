import type Hls from "hls.js";
import { Captions, Maximize, Minimize, Pause, PictureInPicture2, Play } from "lucide-react";
import { formatTime } from "../format";
import type { PlaybackState } from "../hooks/usePlaybackState";
import type { ThumbTile } from "../hooks/useVttThumbnails";
import { SeekBar } from "./SeekBar";
import { SettingsMenu } from "./SettingsMenu";
import { VolumeControl } from "./VolumeControl";

interface Props {
  video: HTMLVideoElement | null;
  hls: Hls | null;
  state: PlaybackState;
  tiles: ThumbTile[] | null;
  hidden: boolean;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  captionsAvailable: boolean;
  captionsOn: boolean;
  onToggleCaptions: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onScrubChange: (scrubbing: boolean) => void;
  onHoldVisible: (hold: boolean) => void;
}

export function ControlBar(p: Props) {
  const { video, state } = p;

  const togglePlay = () => {
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const togglePip = async () => {
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* PiP can be blocked by the browser or the host page; ignore */
    }
  };

  return (
    <div
      className={`evs-p-bar${p.hidden ? " evs-p-hidden" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onPointerEnter={() => p.onHoldVisible(true)}
      onPointerLeave={() => p.onHoldVisible(false)}
    >
      <SeekBar
        currentTime={state.currentTime}
        duration={state.duration}
        buffered={state.buffered}
        tiles={p.tiles}
        onSeek={(t) => {
          if (video) video.currentTime = t;
        }}
        onScrubChange={p.onScrubChange}
      />
      <div className="evs-p-row">
        <button className="evs-p-btn" onClick={togglePlay} title={state.paused ? "Play (k)" : "Pause (k)"} aria-label={state.paused ? "Play" : "Pause"}>
          {state.paused ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}
        </button>
        <VolumeControl
          volume={state.volume}
          muted={state.muted}
          onVolumeChange={(v) => {
            if (!video) return;
            video.volume = v;
            video.muted = v === 0;
          }}
          onToggleMute={() => {
            if (video) video.muted = !video.muted;
          }}
        />
        <span className="evs-p-time">
          {formatTime(state.currentTime)} <span>/ {formatTime(state.duration)}</span>
        </span>
        <div className="evs-p-spacer">
          {p.captionsAvailable && (
            <button className={`evs-p-btn${p.captionsOn ? " evs-p-on" : ""}`} onClick={p.onToggleCaptions} title="Subtitles (c)" aria-label="Subtitles">
              <Captions />
            </button>
          )}
          <SettingsMenu hls={p.hls} playbackRate={p.playbackRate} onPlaybackRateChange={p.onPlaybackRateChange} onOpenChange={p.onHoldVisible} />
          {typeof document !== "undefined" && document.pictureInPictureEnabled && (
            <button className="evs-p-btn" onClick={() => void togglePip()} title="Picture in picture" aria-label="Picture in picture">
              <PictureInPicture2 />
            </button>
          )}
          <button className="evs-p-btn" onClick={p.onToggleFullscreen} title="Fullscreen (f)" aria-label="Fullscreen">
            {p.isFullscreen ? <Minimize /> : <Maximize />}
          </button>
        </div>
      </div>
    </div>
  );
}
