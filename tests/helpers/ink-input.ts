/**
 * Driving keyboard input at an Ink component under test.
 *
 * Ink attaches its stdin listener from an effect, a turn after the first
 * render commits, while ink-testing-library's `write` emits once and buffers
 * nothing. A keypress sent before that listener exists is therefore dropped
 * silently — no error, no warning, the component simply never sees it. Tests
 * that used to spend a single `setTimeout(0)` covering that gap passed on a
 * quiet machine and failed on a loaded CI runner.
 *
 * Waiting on the rendered frame does not help: the frame is on screen a whole
 * turn before the listener is attached. So wait for the listener itself.
 */

/** The subset of ink-testing-library's fake stdin these helpers need. */
export interface TestStdin {
  write: (data: string) => void;
  listenerCount: (event: string) => number;
}

/** Yield one macrotask, letting Ink render and flush its effects. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Resolve once Ink is listening for input, so the next write cannot be lost.
 * Returns immediately once mounted, which makes it cheap to call before every
 * write rather than only the first.
 */
export async function ready(stdin: TestStdin, maxTurns = 100): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    // ink-testing-library's `write` emits "readable"; Ink 5 reads from there.
    if (stdin.listenerCount("readable") > 0) return;
    await tick();
  }
  throw new Error("Ink never attached its stdin listener");
}

/** Send keypresses in order, letting the component settle after each one. */
export async function type(stdin: TestStdin, ...inputs: string[]): Promise<void> {
  await ready(stdin);
  for (const input of inputs) {
    stdin.write(input);
    await tick();
  }
}
