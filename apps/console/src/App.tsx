import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { useMe } from "./api/hooks";
import { Layout } from "./components/Layout";
import { ApiError } from "./lib/api";
import { useSettings } from "./lib/settings";
import { ApiKeysPage } from "./pages/ApiKeys";
import { AuditPage } from "./pages/Audit";
import { ConnectPage } from "./pages/Connect";
import { NotFoundPage } from "./pages/NotFound";
import { OverviewPage } from "./pages/Overview";
import { PoliciesPage } from "./pages/Policies";
import { SessionsPage } from "./pages/Sessions";
import { SettingsPage } from "./pages/Settings";
import { UploadPage } from "./pages/Upload";
import { UsagePage } from "./pages/Usage";
import { VideosPage } from "./pages/Videos";
import { WebhooksPage } from "./pages/Webhooks";

// The player (and hls.js, the largest dependency) loads only when a video is opened.
const VideoDetailPage = lazy(() => import("./pages/VideoDetail").then((m) => ({ default: m.VideoDetailPage })));

/** Gate: no key, or a key the API rejects, shows the connect screen instead of a broken dashboard. */
function Gate() {
  const { apiKey } = useSettings();
  const me = useMe(!!apiKey);
  const rejected = me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403);
  if (!apiKey || rejected) return <ConnectPage rejected={rejected} />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="videos" element={<VideosPage />} />
        <Route
          path="videos/:id"
          element={
            <Suspense fallback={<div className="aspect-video animate-pulse rounded-lg bg-surface" />}>
              <VideoDetailPage />
            </Suspense>
          }
        />
        <Route path="upload" element={<UploadPage />} />
        <Route path="policies" element={<PoliciesPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Gate />
    </BrowserRouter>
  );
}
