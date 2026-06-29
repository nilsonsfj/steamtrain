import { useEffect, useState } from "react";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A custom hook to drive the spinner frames and elapsed seconds timer
 * for active background work or generation panels.
 */
export function useWorkIndicator(active: boolean) {
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!active) return;

    const spinnerInterval = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    const startTime = Date.now();
    const timerInterval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 200);

    return () => {
      clearInterval(spinnerInterval);
      clearInterval(timerInterval);
    };
  }, [active]);

  return { spinnerFrame, elapsedSeconds };
}
