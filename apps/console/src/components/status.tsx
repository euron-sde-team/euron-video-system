import type { ArtifactStatus, Video, VideoStatus } from "../lib/types";
import { ProgressBar, StatusDot, type Tone } from "./ui";

export const STATUS_TONE: Record<VideoStatus, Tone> = {
  uploading: "neutral",
  uploaded: "warn",
  processing: "info",
  ready: "ok",
  failed: "bad",
  cancelled: "neutral",
};

export const STATUS_LABEL: Record<VideoStatus, string> = {
  uploading: "Uploading",
  uploaded: "Queued",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STAGE_LABEL: Record<string, string> = {
  transcoding: "Transcoding",
  packaging: "Packaging + encrypting",
  uploading_output: "Publishing",
};

export function VideoStatusCell({ video }: { video: Video }) {
  if (video.status === "processing") {
    return (
      <div className="w-44">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <StatusDot tone="info" label={video.stage ? STAGE_LABEL[video.stage] ?? video.stage : "Processing"} pulse />
          <span className="tabular-nums text-muted">{video.progress}%</span>
        </div>
        <ProgressBar value={video.progress} />
      </div>
    );
  }
  return <StatusDot tone={STATUS_TONE[video.status]} label={STATUS_LABEL[video.status]} pulse={video.status === "uploaded"} />;
}

const ARTIFACT_TONE: Record<ArtifactStatus, Tone> = { pending: "neutral", processing: "info", ready: "ok", failed: "bad", skipped: "neutral" };
const ARTIFACT_LABEL: Record<ArtifactStatus, string> = { pending: "Pending", processing: "Generating", ready: "Ready", failed: "Failed", skipped: "Skipped" };

export function ArtifactStatus({ status }: { status: ArtifactStatus }) {
  return <StatusDot tone={ARTIFACT_TONE[status]} label={ARTIFACT_LABEL[status]} pulse={status === "processing"} />;
}
