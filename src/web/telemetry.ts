/**
 * Client-side telemetry the engine does not record.
 *
 * The run event stream carries per-step cost and token totals but no rate and
 * no forecast, so the Console's instrument rail derives both here. Kept as pure
 * functions in TypeScript (rather than inline in the vanilla client) so they
 * are unit-testable and shared through the reducer bundle.
 */

export interface ThroughputSample {
  atMs: number;
  totalTokens: number;
}

export interface ThroughputMeter {
  /**
   * Record the run's cumulative token total at a point in time. Safe to call on
   * a fixed tick; samples older than the window are discarded. A total that
   * goes backwards (a reset between runs) contributes no throughput.
   */
  sample(totalTokens: number, nowMs: number): void;
  /**
   * `count` bar heights in 0..1, oldest first, normalised against the busiest
   * interval in the window. Returns all zeros when there is nothing to show, so
   * a caller can render the sparkline unconditionally.
   */
  bars(count: number): number[];
}

const DEFAULT_WINDOW_MS = 60_000;

export function createThroughputMeter(windowMs: number = DEFAULT_WINDOW_MS): ThroughputMeter {
  const samples: ThroughputSample[] = [];

  return {
    sample(totalTokens: number, nowMs: number): void {
      samples.push({ atMs: nowMs, totalTokens });
      while (samples.length > 1 && nowMs - samples[0]!.atMs > windowMs) samples.shift();
    },

    bars(count: number): number[] {
      if (count <= 0) return [];
      const empty = new Array<number>(count).fill(0);
      if (samples.length < 2) return empty;

      // Tokens per second across each adjacent pair of samples.
      const rates: number[] = [];
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1]!;
        const cur = samples[i]!;
        const seconds = (cur.atMs - prev.atMs) / 1000;
        const delta = cur.totalTokens - prev.totalTokens;
        rates.push(seconds > 0 && delta > 0 ? delta / seconds : 0);
      }

      const recent = rates.slice(-count);
      const peak = Math.max(...recent);
      if (peak <= 0) return empty;

      const scaled = recent.map((r) => r / peak);
      return [...new Array<number>(count - scaled.length).fill(0), ...scaled];
    },
  };
}

/**
 * Estimated total spend: what has been spent, scaled by how much of the run
 * remains. A heuristic, and deliberately labelled as one in the UI — it assumes
 * the remaining steps cost about what the finished ones did, which is wrong for
 * workflows whose steps differ greatly (a cheap gate after an expensive scan).
 *
 * Returns null when there is nothing to extrapolate from, so the caller renders
 * a dash rather than a fabricated zero. Never returns less than actual spend.
 */
export function projectCost(input: {
  spentUsd: number;
  completedSteps: number;
  totalSteps: number;
}): number | null {
  const { spentUsd, completedSteps, totalSteps } = input;
  if (completedSteps <= 0 || totalSteps <= 0) return null;
  return Math.max(spentUsd, (spentUsd / completedSteps) * totalSteps);
}
