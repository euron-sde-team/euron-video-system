/**
 * The player ships its own stylesheet so it renders identically inside any host
 * page, with or without Tailwind or a CSS reset. Every class is prefixed
 * `evs-p-` to avoid collisions; theme hooks are CSS custom properties on the
 * root element (`--evs-accent`, `--evs-radius`).
 *
 * Injected once per document on first mount (see useInjectStyles).
 */
export const PLAYER_CSS = `
.evs-p-root{--evs-accent:#4f8cff;--evs-radius:10px;position:relative;overflow:hidden;background:#000;border-radius:var(--evs-radius);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;user-select:none;-webkit-user-select:none;line-height:1.2;width:100%}
.evs-p-root *{box-sizing:border-box}
.evs-p-root.evs-p-fs{border-radius:0;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}
.evs-p-root.evs-p-idle{cursor:none}
.evs-p-video{display:block;width:100%;height:100%;background:#000;object-fit:contain}
.evs-p-btn{appearance:none;background:none;border:0;padding:0;margin:0;color:rgba(255,255,255,.9);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:6px;transition:color .15s,background-color .15s}
.evs-p-btn:hover{color:#fff;background:rgba(255,255,255,.08)}
.evs-p-btn:focus-visible{outline:2px solid var(--evs-accent);outline-offset:1px}
.evs-p-btn.evs-p-on{color:var(--evs-accent)}
.evs-p-btn svg{width:20px;height:20px}
.evs-p-bar{position:absolute;left:0;right:0;bottom:0;z-index:20;padding:28px 12px 8px;background:linear-gradient(to top,rgba(0,0,0,.78),rgba(0,0,0,.35) 60%,transparent);transition:opacity .2s}
.evs-p-bar.evs-p-hidden{opacity:0;pointer-events:none}
.evs-p-row{display:flex;align-items:center;gap:4px;margin-top:4px}
.evs-p-spacer{margin-left:auto;display:flex;align-items:center;gap:4px}
.evs-p-time{margin-left:6px;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.92);white-space:nowrap}
.evs-p-time span{color:rgba(255,255,255,.5)}
.evs-p-seek{position:relative}
.evs-p-hit{height:16px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.evs-p-track{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.22);transition:height .12s}
.evs-p-hit:hover .evs-p-track{height:6px}
.evs-p-buf{position:absolute;top:0;bottom:0;border-radius:2px;background:rgba(255,255,255,.32)}
.evs-p-played{position:absolute;top:0;bottom:0;left:0;border-radius:2px;background:var(--evs-accent)}
.evs-p-knob{position:absolute;top:50%;width:12px;height:12px;border-radius:50%;background:var(--evs-accent);transform:translate(-50%,-50%);opacity:0;transition:opacity .12s;box-shadow:0 1px 3px rgba(0,0,0,.5)}
.evs-p-hit:hover .evs-p-knob,.evs-p-knob.evs-p-drag{opacity:1}
.evs-p-preview{position:absolute;bottom:22px;z-index:10;transform:translateX(-50%);pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:4px}
.evs-p-thumb{border:1px solid rgba(255,255,255,.22);border-radius:6px;background-repeat:no-repeat;box-shadow:0 4px 16px rgba(0,0,0,.5)}
.evs-p-chip{background:rgba(0,0,0,.82);border-radius:4px;padding:2px 6px;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.evs-p-vol{display:flex;align-items:center}
.evs-p-vol-slider{width:0;overflow:hidden;transition:width .2s}
.evs-p-vol:hover .evs-p-vol-slider,.evs-p-vol:focus-within .evs-p-vol-slider{width:80px}
.evs-p-vol-slider input{width:76px;height:4px;accent-color:#fff;cursor:pointer}
.evs-p-menu-wrap{position:relative}
.evs-p-menu{position:absolute;right:0;bottom:44px;z-index:30;min-width:228px;padding:6px 4px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(12,12,14,.94);backdrop-filter:blur(8px);box-shadow:0 12px 32px rgba(0,0,0,.5)}
.evs-p-mrow{appearance:none;border:0;background:none;width:100%;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:8px 10px;border-radius:5px;color:#e5e7eb;font-size:13px;text-align:left;cursor:pointer}
.evs-p-mrow:hover{background:rgba(255,255,255,.08)}
.evs-p-mrow:disabled{opacity:.4;cursor:not-allowed}
.evs-p-mrow svg{width:16px;height:16px}
.evs-p-mval{display:flex;align-items:center;gap:4px;color:#9ca3af}
.evs-p-mhead{font-weight:600;color:#f3f4f6;justify-content:flex-start;gap:8px;border-bottom:1px solid rgba(255,255,255,.08);border-radius:0;margin-bottom:4px}
.evs-p-mopt{justify-content:flex-start;gap:8px;padding:6px 10px}
.evs-p-mlist{max-height:224px;overflow-y:auto}
.evs-p-check{opacity:0}
.evs-p-check.evs-p-sel{opacity:1}
.evs-p-overlay{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.evs-p-overlay.evs-p-dim{background:rgba(0,0,0,.42)}
.evs-p-overlay.evs-p-err{z-index:30;background:rgba(0,0,0,.84);padding:0 24px;text-align:center}
.evs-p-overlay.evs-p-passive{pointer-events:none}
.evs-p-big{appearance:none;border:0;cursor:pointer;width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);transition:transform .15s}
.evs-p-big:hover{transform:scale(1.05)}
.evs-p-big svg{width:32px;height:32px}
.evs-p-spin{width:44px;height:44px;border-radius:50%;border:3px solid rgba(255,255,255,.2);border-top-color:#fff;animation:evs-p-rot .8s linear infinite}
@keyframes evs-p-rot{to{transform:rotate(360deg)}}
.evs-p-errmsg{max-width:380px;font-size:14px;color:#e5e7eb}
.evs-p-errcode{font-size:12px;color:#6b7280}
.evs-p-retry{appearance:none;border:0;cursor:pointer;display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:600;color:#fff;background:var(--evs-accent)}
.evs-p-retry svg{width:16px;height:16px}
.evs-p-osd{position:absolute;left:50%;top:50%;z-index:30;transform:translate(-50%,-50%);pointer-events:none;padding:8px 16px;border-radius:8px;background:rgba(0,0,0,.7);font-size:15px;font-weight:600}
.evs-p-wm{position:absolute;z-index:25;pointer-events:none;white-space:nowrap;font-size:clamp(13px,2.2vw,19px);font-weight:600;letter-spacing:.02em;text-shadow:0 1px 3px rgba(0,0,0,.85);transition:top .6s ease,left .6s ease}
`;
