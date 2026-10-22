import { useEffect } from "react";
import { PLAYER_CSS } from "../styles";

const ATTR = "data-evs-player-styles";

/** Inject the player stylesheet once per document. Idempotent across instances. */
export function useInjectStyles(): void {
  useEffect(() => {
    if (document.head.querySelector(`style[${ATTR}]`)) return;
    const el = document.createElement("style");
    el.setAttribute(ATTR, "");
    el.textContent = PLAYER_CSS;
    document.head.appendChild(el);
  }, []);
}
