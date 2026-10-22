import { Film } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import type { Video } from "../lib/types";

/**
 * Small 16:9 poster thumbnail for list rows. The API returns a short-lived
 * signed posterUrl for ready videos; portrait sources are letterboxed (never
 * cropped) so a vertical video reads as vertical. Anything without a poster,
 * or whose signed URL has expired, falls back to a neutral placeholder.
 */
export function Poster({ video, className }: { video: Pick<Video, "posterUrl" | "orientation" | "title">; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = !failed ? video.posterUrl : null;
  return (
    <div
      className={cn(
        "relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-black",
        className
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className={cn("h-full w-full", video.orientation === "portrait" ? "object-contain" : "object-cover")}
        />
      ) : (
        <Film className="h-3.5 w-3.5 text-faint" aria-hidden />
      )}
    </div>
  );
}
