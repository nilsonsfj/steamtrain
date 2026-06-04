import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Track terminal dimensions, updating on resize. Falls back to 80x24. */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
