import { useState, useSyncExternalStore } from "react";
import { completeVideo, createVideo, useInvalidateAll } from "../../api/hooks";
import { ApiError, errorMessage } from "../../lib/api";
import { titleFromFilename, UploadQueue, xhrTransfer } from "./uploadQueue";

export const UPLOAD_CONCURRENCY = 3;

/** React binding for UploadQueue: one queue per mounted Upload page. */
export function useUploadManager() {
  const invalidate = useInvalidateAll();
  // Lazy initializer: exactly one queue for the lifetime of the page.
  const [queue] = useState(
    () =>
      new UploadQueue<File>(
        {
          createVideo: async (file) => {
            const res = await createVideo({ title: titleFromFilename(file.name), filename: file.name });
            return { videoId: res.video.id, url: res.upload.url, fields: res.upload.fields };
          },
          completeVideo,
          transfer: xhrTransfer,
          describeError: (err) =>
            err instanceof ApiError && err.status === 429 ? "Too many videos in flight. Let some finish, then retry." : errorMessage(err),
          onSettled: () => void invalidate(),
        },
        UPLOAD_CONCURRENCY
      )
  );
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  return {
    items,
    addFiles: (files: File[]) => queue.add(files),
    cancelItem: (id: string) => queue.cancel(id),
    clearFinished: () => queue.clearFinished(),
  };
}
