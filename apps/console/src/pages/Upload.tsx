import { FileVideo, UploadCloud, X } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/toast";
import { Button, IconButton, PageHeader, Panel, ProgressBar, StatusDot, type Tone } from "../components/ui";
import { ALLOWED_UPLOAD_EXTS, type UploadItem, type UploadStatus } from "../features/upload/uploadQueue";
import { UPLOAD_CONCURRENCY, useUploadManager } from "../features/upload/useUploadManager";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";

const STATUS: Record<UploadStatus, { tone: Tone; label: string }> = {
  queued: { tone: "neutral", label: "Waiting" },
  creating: { tone: "info", label: "Preparing" },
  uploading: { tone: "info", label: "Uploading" },
  completing: { tone: "info", label: "Verifying" },
  done: { tone: "ok", label: "Queued for transcoding" },
  error: { tone: "bad", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function UploadPage() {
  const { items, addFiles, cancelItem, clearFinished } = useUploadManager();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const accept = (files: FileList | null) => {
    if (!files?.length) return;
    const { rejected } = addFiles(Array.from(files));
    if (rejected.length) toast.error(`Skipped unsupported file${rejected.length > 1 ? "s" : ""}: ${rejected.join(", ")}`);
  };

  const finished = items.filter((i) => ["done", "error", "cancelled"].includes(i.status)).length;

  return (
    <>
      <PageHeader
        title="Upload"
        description={`Files go straight from this browser to object storage with a presigned POST; the API never proxies video bytes. ${UPLOAD_CONCURRENCY} transfers run at once.`}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center transition-colors",
          dragging ? "border-accent bg-accent/5" : "border-line bg-surface hover:border-faint"
        )}
      >
        <UploadCloud className="h-6 w-6 text-muted" />
        <p className="mt-3 font-medium">Drop video files here, or click to browse</p>
        <p className="mt-1 text-xs text-faint">{ALLOWED_UPLOAD_EXTS.map((e) => `.${e}`).join("  ")}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ALLOWED_UPLOAD_EXTS.map((e) => `.${e}`).join(",")}
          className="hidden"
          onChange={(e) => {
            accept(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <Panel
          className="mt-6"
          flush
          title={`Transfers (${items.length})`}
          actions={
            finished > 0 && (
              <Button size="sm" variant="ghost" onClick={clearFinished}>
                Clear finished
              </Button>
            )
          }
        >
          <ul className="divide-y divide-line/70">
            {items.map((item) => (
              <UploadRow key={item.clientId} item={item} onCancel={() => cancelItem(item.clientId)} />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

function UploadRow({ item, onCancel }: { item: UploadItem; onCancel: () => void }) {
  const s = STATUS[item.status];
  const cancellable = ["queued", "uploading"].includes(item.status);
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <FileVideo className="h-4 w-4 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-medium">{item.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted">{formatBytes(item.size)}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <ProgressBar value={item.status === "done" ? 100 : item.progress} tone={item.status === "error" ? "bad" : item.status === "done" ? "ok" : "info"} className="flex-1" />
          <span className="w-44 shrink-0 text-xs">
            <StatusDot tone={s.tone} label={item.status === "uploading" ? `${s.label} ${item.progress}%` : s.label} />
          </span>
        </div>
        {item.error && <div className="mt-1 text-xs text-bad">{item.error}</div>}
      </div>
      <div className="flex w-20 shrink-0 justify-end">
        {item.status === "done" && item.videoId ? (
          <Link to={`/videos/${item.videoId}`} className="text-xs text-accent hover:underline">
            View
          </Link>
        ) : cancellable ? (
          <IconButton label="Cancel upload" onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        ) : null}
      </div>
    </li>
  );
}
