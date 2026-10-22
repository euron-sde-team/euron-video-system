import { MoreHorizontal, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDeleteVideo, useUpdateVideo, useVideoAction, useVideos } from "../api/hooks";
import { Poster } from "../components/Poster";
import { STATUS_LABEL, VideoStatusCell } from "../components/status";
import { useToast } from "../components/toast";
import { Button, ConfirmDialog, Dialog, Empty, ErrorNote, Field, IconButton, Input, Mono, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { formatBytes, formatDuration, formatRelative } from "../lib/format";
import { TERMINAL, VIDEO_STATUSES, type Video } from "../lib/types";

const LIMIT = 25;

export function VideosPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const page = Number(params.get("page") ?? "1") || 1;
  const [q, setQ] = useState(params.get("q") ?? "");

  // Debounce search into the URL so the list is shareable and back-button friendly.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (q) next.set("q", q);
      else next.delete("q");
      if ((params.get("q") ?? "") !== q) {
        next.delete("page");
        setParams(next, { replace: true });
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, params, setParams]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  };

  const list = useVideos({ status: status || undefined, q: params.get("q") || undefined, page, limit: LIMIT });
  const total = list.data?.pagination.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <>
      <PageHeader
        title="Videos"
        description="Every asset in this deployment, from upload through encrypted delivery."
        actions={
          <Link to="/upload">
            <Button variant="primary">Upload</Button>
          </Link>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or external ref" className="pl-8" />
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5">
          {["", ...VIDEO_STATUSES].map((s) => (
            <button
              key={s || "all"}
              onClick={() => setFilter("status", s)}
              className={cn("h-7 rounded px-2.5 text-xs transition-colors", status === s ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")}
            >
              {s ? STATUS_LABEL[s as Video["status"]] : "All"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-faint">{list.data ? `${total} video${total === 1 ? "" : "s"}` : ""}</span>
      </div>

      {list.isError && (
        <div className="mb-3">
          <ErrorNote error={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </div>
      )}

      <Panel flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr>
                {/* Explicit widths: the title cell truncates with max-w-0, which needs a sized column. */}
                <th className="th w-[44%]">Title</th>
                <th className="th w-[18%]">Status</th>
                <th className="th w-[8%] text-right">Duration</th>
                <th className="th w-[9%] text-right">Source</th>
                <th className="th w-[9%] text-right">Output</th>
                <th className="th w-[10%] text-right">Created</th>
                <th className="th w-10" />
              </tr>
            </thead>
            <tbody>
              {list.isLoading && <SkeletonRows rows={8} cols={7} />}
              {list.data?.data.map((v) => <VideoRow key={v.id} video={v} />)}
            </tbody>
          </table>
        </div>
        {list.data && list.data.data.length === 0 && (
          <Empty
            title={status || params.get("q") ? "No videos match these filters" : "No videos yet"}
            description={status || params.get("q") ? "Try a different status or search." : "Uploaded videos appear here as they move through the pipeline."}
          />
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-muted">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setFilter("page", String(page - 1))}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setFilter("page", String(page + 1))}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}

function VideoRow({ video }: { video: Video }) {
  return (
    <tr className="group hover:bg-raised/50">
      <td className="td max-w-0">
        <div className="flex items-center gap-3">
          <Poster video={video} />
          <div className="min-w-0">
            <Link to={`/videos/${video.id}`} className="block truncate font-medium hover:underline">
              {video.title}
            </Link>
            <Mono className="block truncate text-2xs text-faint">{video.externalRef ?? video.id}</Mono>
            {video.status === "failed" && video.error && <div className="mt-0.5 truncate text-xs text-bad">{video.error}</div>}
          </div>
        </div>
      </td>
      <td className="td">
        <VideoStatusCell video={video} />
      </td>
      <td className="td text-right tabular-nums">{formatDuration(video.durationSeconds)}</td>
      <td className="td text-right tabular-nums text-muted">{formatBytes(video.sourceBytes)}</td>
      <td className="td text-right tabular-nums text-muted">{formatBytes(video.outputBytes)}</td>
      <td className="td whitespace-nowrap text-right text-muted">{formatRelative(video.createdAt)}</td>
      <td className="td text-right">
        <RowActions video={video} />
      </td>
    </tr>
  );
}

function RowActions({ video }: { video: Video }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [title, setTitle] = useState(video.title);
  const ref = useRef<HTMLDivElement>(null);
  const action = useVideoAction();
  const update = useUpdateVideo();
  const remove = useDeleteVideo();
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = (fn: () => Promise<unknown>, ok: string) => {
    setOpen(false);
    fn().then(
      () => toast.ok(ok),
      (err) => toast.error(errorMessage(err))
    );
  };

  const item = "flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div ref={ref} className="relative inline-block">
      <IconButton label="Actions" onClick={() => setOpen((o) => !o)} className="opacity-60 group-hover:opacity-100">
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-8 z-20 w-44 rounded-md border border-line bg-surface py-1 shadow-xl">
          <button
            className={item}
            onClick={() => {
              setOpen(false);
              setTitle(video.title);
              setDialog("rename");
            }}
          >
            Rename
          </button>
          <button className={item} disabled={video.status !== "failed"} onClick={() => run(() => action.mutateAsync({ id: video.id, action: "retry" }), "Requeued for transcoding")}>
            Retry
          </button>
          <button className={item} disabled={TERMINAL.includes(video.status) && video.status !== "failed"} onClick={() => run(() => action.mutateAsync({ id: video.id, action: "cancel" }), "Video cancelled")}>
            Cancel
          </button>
          <div className="my-1 border-t border-line" />
          <button
            className={cn(item, "text-bad")}
            onClick={() => {
              setOpen(false);
              setDialog("delete");
            }}
          >
            Delete
          </button>
        </div>
      )}

      <Dialog
        open={dialog === "rename"}
        onClose={() => setDialog(null)}
        title="Rename video"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!title.trim()}
              onClick={() =>
                update.mutateAsync({ id: video.id, title: title.trim() }).then(
                  () => {
                    setDialog(null);
                    toast.ok("Video renamed");
                  },
                  (err) => toast.error(errorMessage(err))
                )
              }
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        title="Delete video"
        description={
          <>
            <span className="font-medium text-fg">{video.title}</span> and all of its renditions, keys and sessions will be permanently removed. Viewers lose access immediately.
          </>
        }
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutateAsync(video.id).then(
            () => {
              setDialog(null);
              toast.ok("Video deleted");
            },
            (err) => toast.error(errorMessage(err))
          )
        }
      />
    </div>
  );
}
