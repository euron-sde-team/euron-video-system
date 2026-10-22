/**
 * Trigger a file download from a (cross-origin) presigned URL without leaving
 * the SPA. The URL carries Content-Disposition: attachment, so the browser
 * saves rather than navigates; `download` is only a filename hint.
 */
export function triggerBrowserDownload(url: string, filename?: string): void {
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
