import {
  Activity,
  BarChart3,
  Film,
  KeyRound,
  LayoutDashboard,
  Moon,
  RadioTower,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  Upload,
  Webhook,
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useMe } from "../api/hooks";
import { describeScopes } from "../lib/format";
import { cn } from "../lib/cn";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { IconButton } from "./ui";

const NAV: Array<{ group?: string; items: Array<{ to: string; label: string; icon: ReactNode; end?: boolean }> }> = [
  {
    items: [
      { to: "/", label: "Overview", icon: <LayoutDashboard />, end: true },
      { to: "/videos", label: "Videos", icon: <Film /> },
      { to: "/upload", label: "Upload", icon: <Upload /> },
    ],
  },
  {
    group: "Delivery",
    items: [
      { to: "/policies", label: "Playback policies", icon: <ShieldCheck /> },
      { to: "/sessions", label: "Sessions", icon: <RadioTower /> },
    ],
  },
  {
    group: "Developers",
    items: [
      { to: "/api-keys", label: "API keys", icon: <KeyRound /> },
      { to: "/webhooks", label: "Webhooks", icon: <Webhook /> },
    ],
  },
  {
    group: "Governance",
    items: [
      { to: "/audit", label: "Audit log", icon: <ScrollText /> },
      { to: "/usage", label: "Usage", icon: <BarChart3 /> },
    ],
  },
];

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" className="fill-fg" />
      <path d="M12 9.5v13l10-6.5z" className="fill-bg" />
    </svg>
  );
}

export function Layout() {
  const [theme, toggleTheme] = useTheme();
  const settings = useSettings();
  const me = useMe();
  const host = (() => {
    try {
      return new URL(settings.apiBase).host;
    } catch {
      return settings.apiBase;
    }
  })();

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <Logo className="h-6 w-6" />
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">Euron Video System</div>
            <div className="text-2xs text-faint">Control plane</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((section, i) => (
            <div key={i} className={cn(i > 0 && "mt-5")}>
              {section.group && <div className="mb-1 px-2 text-2xs font-medium uppercase tracking-wider text-faint">{section.group}</div>}
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors [&_svg]:h-4 [&_svg]:w-4",
                      isActive ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
                    )
                  }
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-2">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn("flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors", isActive ? "bg-raised" : "hover:bg-raised/60")
            }
          >
            <span className={cn("h-2 w-2 shrink-0 rounded-full", me.isSuccess ? "bg-ok" : me.isError ? "bg-bad" : "bg-faint")} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{me.data?.apiKey.name ?? "Not connected"}</span>
              <span className="block truncate font-mono text-2xs text-faint">{host}</span>
            </span>
            <Settings className="h-3.5 w-3.5 text-faint" />
          </NavLink>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-end gap-1 border-b border-line px-6">
          <span className="mr-auto flex items-center gap-2 text-xs text-faint">
            <Activity className="h-3.5 w-3.5" />
            {me.isSuccess ? `${me.data.apiKey.prefix} / ${describeScopes(me.data.apiKey.scopes)}` : "Checking connection"}
          </span>
          <IconButton label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </IconButton>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1280px] px-6 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
