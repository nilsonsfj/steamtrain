import { useEffect, useState } from "react";
import { SPINNER_FRAMES, SPINNER_STATIC } from "./theme";

/**
 * A shared spinner frame for every running indicator in a view. Ticks only
 * while `active` (a live run with something actually running); inactive views
 * (finished runs, history replays) get a static glyph and no timer.
 */
export function useSpinner(active: boolean, intervalMs = 120): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return active ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length]! : SPINNER_STATIC;
}
