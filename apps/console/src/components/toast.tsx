import { CheckCircle2, XCircle } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { cn } from "../lib/cn";

interface ToastItem {
  id: number;
  tone: "ok" | "bad";
  text: string;
}

const ToastContext = createContext<(tone: ToastItem["tone"], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((tone: ToastItem["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={cn("pointer-events-auto flex items-start gap-2 rounded-md border bg-surface px-3 py-2.5 shadow-lg", t.tone === "ok" ? "border-line" : "border-bad/40")}>
            {t.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" />}
            <span className="text-[13px]">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const push = useContext(ToastContext);
  return { ok: (text: string) => push("ok", text), error: (text: string) => push("bad", text) };
};
