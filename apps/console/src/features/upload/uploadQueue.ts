/**
 * Browser upload pipeline, framework-free so it is unit-testable.
 *
 * Per file: create the video (the API returns a presigned POST) -> POST the
 * bytes straight to object storage with progress -> confirm with /complete (the
 * API verifies the object exists before enqueueing it). Up to `concurrency`
 * files run at once; the rest wait. File objects are released the moment a
 * transfer settles so large blobs are never held longer than needed.
 */

export const ALLOWED_UPLOAD_EXTS = ["mp4", "mov", "mkv", "webm", "m4v"] as const;

export type UploadStatus = "queued" | "creating" | "uploading" | "completing" | "done" | "error" | "cancelled";

export interface UploadItem {
  clientId: string;
  name: string;
  size: number;
  status: UploadStatus;
  progress: number; // 0..100 of the storage transfer
  videoId?: string;
  error?: string;
}

export interface UploadFile {
  name: string;
  size: number;
  type: string;
}

export interface Transfer {
  done: Promise<void>;
  abort: () => void;
}

export interface UploadDeps<F extends UploadFile> {
  createVideo: (file: F) => Promise<{ videoId: string; url: string; fields: Record<string, string> }>;
  completeVideo: (videoId: string) => Promise<unknown>;
  /** Start the storage POST. Must reject with AbortedError when aborted. */
  transfer: (args: { url: string; fields: Record<string, string>; file: F; contentType: string; onProgress: (pct: number) => void }) => Transfer;
  describeError?: (err: unknown) => string;
  onSettled?: () => void;
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

const ACTIVE: UploadStatus[] = ["creating", "uploading", "completing"];
const FINISHED: UploadStatus[] = ["done", "error", "cancelled"];

export const extOf = (name: string): string => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");

const EXT_CONTENT_TYPE: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  m4v: "video/x-m4v",
};

/**
 * The presigned POST policy requires a Content-Type starting with "video/".
 * Browsers report an empty type for some containers (.mkv, .m4v), so fall back
 * to the extension map; the field is then always a valid video/* value.
 */
export const contentTypeFor = (file: UploadFile): string =>
  file.type.startsWith("video/") ? file.type : (EXT_CONTENT_TYPE[extOf(file.name)] ?? "video/mp4");

/** Title shown in the console: the filename without its extension. */
export const titleFromFilename = (name: string): string => name.replace(/\.[^.]+$/, "").trim() || name;

export class UploadQueue<F extends UploadFile> {
  private list: UploadItem[] = [];
  private files = new Map<string, F>();
  private transfers = new Map<string, Transfer>();
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(
    private readonly deps: UploadDeps<F>,
    private readonly concurrency = 3
  ) {}

  get items(): UploadItem[] {
    return this.list;
  }

  get activeCount(): number {
    return this.list.filter((i) => ACTIVE.includes(i.status)).length;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): UploadItem[] => this.list;

  /** Queue files; returns names rejected for an unsupported extension. */
  add(files: F[]): { rejected: string[] } {
    const rejected: string[] = [];
    const accepted: UploadItem[] = [];
    for (const file of files) {
      if (!(ALLOWED_UPLOAD_EXTS as readonly string[]).includes(extOf(file.name))) {
        rejected.push(file.name);
        continue;
      }
      const clientId = `u${++this.seq}`;
      this.files.set(clientId, file);
      accepted.push({ clientId, name: file.name, size: file.size, status: "queued", progress: 0 });
    }
    if (accepted.length) {
      this.commit([...this.list, ...accepted]);
      this.pump();
    }
    return { rejected };
  }

  cancel(clientId: string): void {
    const t = this.transfers.get(clientId);
    if (t) {
      t.abort();
      return;
    }
    const it = this.list.find((i) => i.clientId === clientId);
    if (it?.status === "queued") {
      this.files.delete(clientId);
      this.patch(clientId, { status: "cancelled" });
    }
  }

  clearFinished(): void {
    this.commit(this.list.filter((i) => !FINISHED.includes(i.status)));
  }

  private commit(next: UploadItem[]): void {
    this.list = next;
    this.listeners.forEach((l) => l());
  }

  private patch(clientId: string, p: Partial<UploadItem>): void {
    this.commit(this.list.map((i) => (i.clientId === clientId ? { ...i, ...p } : i)));
  }

  /** Start queued items until the concurrency window is full. Re-runs as slots free. */
  private pump(): void {
    let slots = this.concurrency - this.activeCount;
    for (const it of this.list) {
      if (slots <= 0) break;
      if (it.status !== "queued") continue;
      slots -= 1;
      // Mark active synchronously so a re-entrant pump never double-starts it.
      this.patch(it.clientId, { status: "creating" });
      void this.run(it.clientId).finally(() => this.pump());
    }
  }

  private async run(clientId: string): Promise<void> {
    const file = this.files.get(clientId);
    if (!file) return;
    try {
      const { videoId, url, fields } = await this.deps.createVideo(file);
      this.patch(clientId, { status: "uploading", videoId, progress: 0 });

      const transfer = this.deps.transfer({
        url,
        fields,
        file,
        contentType: contentTypeFor(file),
        onProgress: (progress) => this.patch(clientId, { progress }),
      });
      this.transfers.set(clientId, transfer);
      await transfer.done;

      this.patch(clientId, { status: "completing", progress: 100 });
      await this.deps.completeVideo(videoId);
      this.patch(clientId, { status: "done" });
    } catch (err) {
      if (err instanceof AbortedError) this.patch(clientId, { status: "cancelled" });
      else this.patch(clientId, { status: "error", error: this.deps.describeError?.(err) ?? (err as Error)?.message ?? "Upload failed" });
    } finally {
      this.files.delete(clientId);
      this.transfers.delete(clientId);
      this.deps.onSettled?.();
    }
  }
}

/** Storage POST via XHR (fetch has no upload-progress events). */
export function xhrTransfer(args: { url: string; fields: Record<string, string>; file: File; contentType: string; onProgress: (pct: number) => void }): Transfer {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    const form = new FormData();
    // S3 presigned POST requires policy fields BEFORE the file, and ignores any
    // field after it. Content-Type is sent explicitly because the policy checks
    // the form field, not the file part's header.
    Object.entries(args.fields).forEach(([k, v]) => form.append(k, v));
    form.append("Content-Type", args.contentType);
    form.append("file", args.file);
    xhr.open("POST", args.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && args.onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage rejected the upload (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new AbortedError());
    xhr.send(form);
  });
  return { done, abort: () => xhr.abort() };
}
