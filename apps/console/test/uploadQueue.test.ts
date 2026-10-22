import { describe, expect, it, vi } from "vitest";
import { AbortedError, contentTypeFor, extOf, titleFromFilename, type Transfer, UploadQueue, type UploadFile } from "../src/features/upload/uploadQueue";
import { deferred, type Deferred, flush } from "./helpers";

const file = (name: string, type = "video/mp4", size = 1000): UploadFile => ({ name, type, size });

/** A queue whose storage transfers are held open until the test releases them. */
function harness(concurrency = 3) {
  const transfers = new Map<string, Deferred<void>>();
  const aborts = new Map<string, () => void>();
  const createVideo = vi.fn(async (f: UploadFile) => ({ videoId: `vid_${f.name}`, url: "https://storage.test/upload", fields: { key: f.name } }));
  const completeVideo = vi.fn(async () => ({}));
  const transferArgs: Array<{ contentType: string; fields: Record<string, string> }> = [];
  const queue = new UploadQueue<UploadFile>(
    {
      createVideo,
      completeVideo,
      transfer: ({ file: f, contentType, fields }): Transfer => {
        const d = deferred<void>();
        transfers.set(f.name, d);
        transferArgs.push({ contentType, fields });
        const abort = () => d.reject(new AbortedError());
        aborts.set(f.name, abort);
        return { done: d.promise, abort };
      },
      describeError: (e) => `described: ${(e as Error).message}`,
    },
    concurrency
  );
  return { queue, transfers, createVideo, completeVideo, transferArgs };
}

const statusOf = (q: UploadQueue<UploadFile>, name: string) => q.items.find((i) => i.name === name)?.status;

describe("UploadQueue concurrency", () => {
  it("runs at most 3 uploads at once and starts the next as a slot frees", async () => {
    const { queue, transfers, completeVideo } = harness(3);
    queue.add(["a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4"].map((n) => file(n)));
    await flush();

    expect(queue.activeCount).toBe(3);
    expect(queue.items.map((i) => i.status)).toEqual(["uploading", "uploading", "uploading", "queued", "queued"]);
    expect([...transfers.keys()]).toEqual(["a.mp4", "b.mp4", "c.mp4"]);

    transfers.get("b.mp4")?.resolve();
    await flush(10);
    expect(statusOf(queue, "b.mp4")).toBe("done");
    expect(completeVideo).toHaveBeenCalledWith("vid_b.mp4");
    expect(statusOf(queue, "d.mp4")).toBe("uploading");
    expect(statusOf(queue, "e.mp4")).toBe("queued");
    expect(queue.activeCount).toBe(3);

    for (const n of ["a.mp4", "c.mp4", "d.mp4"]) transfers.get(n)?.resolve();
    await flush(10);
    transfers.get("e.mp4")?.resolve();
    await flush(10);
    expect(queue.items.every((i) => i.status === "done")).toBe(true);
    expect(queue.activeCount).toBe(0);
  });

  it("never exceeds the window even when many files are added in bursts", async () => {
    const { queue, transfers } = harness(3);
    let peak = 0;
    queue.subscribe(() => (peak = Math.max(peak, queue.activeCount)));
    queue.add(Array.from({ length: 6 }, (_, i) => file(`f${i}.mov`, "video/quicktime")));
    queue.add(Array.from({ length: 6 }, (_, i) => file(`g${i}.webm`, "video/webm")));
    await flush();
    for (let round = 0; round < 12; round++) {
      for (const [, d] of transfers) d.resolve();
      await flush(10);
    }
    expect(peak).toBe(3);
    expect(queue.items.filter((i) => i.status === "done")).toHaveLength(12);
  });
});

describe("UploadQueue lifecycle", () => {
  it("rejects unsupported extensions without queueing them", () => {
    const { queue, createVideo } = harness();
    const { rejected } = queue.add([file("notes.txt", "text/plain"), file("noext"), file("ok.MKV", "")]);
    expect(rejected).toEqual(["notes.txt", "noext"]);
    expect(queue.items.map((i) => i.name)).toEqual(["ok.MKV"]);
    expect(createVideo).toHaveBeenCalledTimes(1);
  });

  it("marks an aborted transfer cancelled and a queued item cancelled without starting it", async () => {
    const { queue, createVideo } = harness(1);
    queue.add([file("a.mp4"), file("b.mp4")]);
    await flush();
    const [a, b] = queue.items;
    queue.cancel(b!.clientId);
    expect(statusOf(queue, "b.mp4")).toBe("cancelled");
    queue.cancel(a!.clientId);
    await flush(10);
    expect(statusOf(queue, "a.mp4")).toBe("cancelled");
    expect(createVideo).toHaveBeenCalledTimes(1);
  });

  it("surfaces failures through describeError and frees the slot", async () => {
    const { queue, transfers } = harness(1);
    queue.add([file("a.mp4"), file("b.mp4")]);
    await flush();
    transfers.get("a.mp4")?.reject(new Error("Storage rejected the upload (403)"));
    await flush(10);
    expect(queue.items[0]).toMatchObject({ status: "error", error: "described: Storage rejected the upload (403)" });
    expect(statusOf(queue, "b.mp4")).toBe("uploading");
  });

  it("tracks progress and clears finished items", async () => {
    const { queue, transfers } = harness(2);
    const progress: number[] = [];
    queue.subscribe(() => progress.push(queue.items[0]?.progress ?? -1));
    queue.add([file("a.mp4"), file("b.mp4")]);
    await flush();
    transfers.get("a.mp4")?.resolve();
    await flush(10);
    expect(queue.items[0]?.progress).toBe(100);
    queue.clearFinished();
    expect(queue.items.map((i) => i.name)).toEqual(["b.mp4"]);
  });

  it("passes the presigned fields and a video/* content type to the transfer", async () => {
    const { queue, transferArgs } = harness();
    queue.add([file("clip.mkv", "")]);
    await flush();
    expect(transferArgs[0]).toEqual({ contentType: "video/x-matroska", fields: { key: "clip.mkv" } });
  });
});

describe("upload helpers", () => {
  it("derives the content type from the browser type, then the extension", () => {
    expect(contentTypeFor(file("a.mov", "video/quicktime"))).toBe("video/quicktime");
    expect(contentTypeFor(file("a.m4v", ""))).toBe("video/x-m4v");
    expect(contentTypeFor(file("a.mp4", "application/octet-stream"))).toBe("video/mp4");
  });

  it("extracts extensions and titles", () => {
    expect(extOf("My.Talk.MP4")).toBe("mp4");
    expect(extOf("README")).toBe("");
    expect(titleFromFilename("Quarterly review.final.mov")).toBe("Quarterly review.final");
    expect(titleFromFilename(".mp4")).toBe(".mp4");
  });
});
