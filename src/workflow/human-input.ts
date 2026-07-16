/**
 * Human-as-a-step (next-frontier §3). A `kind: "human"` step is one whose
 * output a *person* supplies: paste the incident timeline, pick one of three
 * proposed designs, answer the question an agent is stuck on. Approval gates
 * made the human a binary comparator; human steps make the human a data
 * source — downstream steps consume `{{steps.<id>.output}}` (and, with an
 * `output` schema, `{{steps.<id>.json.<path>}}`) like any other step.
 *
 * The same request/provider shape also carries **agent clarifying questions**
 * (`canAsk: true` on worker/processor steps): the agent emits a `QUESTION: …`
 * marker instead of guessing, the engine pauses the step, surfaces the
 * question through the identical human-input UI, and resumes the agent's
 * session with the answer. `origin` distinguishes the two for labeling.
 *
 * Like approvals, the engine stays UI-agnostic: it emits a
 * `human_input_pending` event and awaits the injected {@link
 * HumanInputProvider}. The provider is:
 *
 *  - the TUI: an inline answer box on the pending-input card;
 *  - the web UI: a form card resolved by `POST /api/runs/:id/input`;
 *  - the headless CLI: `--human <stepId>=<value|@file>` values resolved
 *    immediately (see {@link headlessHumanInputProvider}) — a step with no
 *    supplied value fails fast with guidance instead of hanging CI;
 *  - a detached run: any attached UI writes a response file into the live-run
 *    store (`steamtrain workflow answer`), which the runner polls.
 *
 * Unlike approval decisions, accepted answers ARE cached: they are data, so a
 * resumed run replays them instead of re-asking (run `--fresh` to re-ask).
 */

import { type JsonSchema, parseStructuredOutput } from "./structured";

/** Prompt text surfaced to the human is truncated to this many chars. */
export const HUMAN_INPUT_PROMPT_CAP = 8000;
/** Recorded response value in events is truncated to this many chars. */
export const HUMAN_INPUT_VALUE_CAP = 20000;
/**
 * How many times the engine re-asks after an invalid answer (wrong choice,
 * schema mismatch) before failing the step. Headless providers return the same
 * value every attempt, so they effectively get one shot.
 */
export const HUMAN_INPUT_MAX_ATTEMPTS = 3;

/** Where a pending input request comes from, for UI labeling. */
export type HumanInputOrigin = "human-step" | "agent-question";

/**
 * A pending human-input request the engine surfaces to a provider. Everything
 * a UI needs to render the ask — no back-reference into engine internals.
 */
export interface HumanInputRequest {
  /** The asking step's own id (the `human` step, or the `canAsk` agent step). */
  stepId: string;
  /** Phase id the step lives in (for correlation with the live tree). */
  phaseId: string;
  /** Loop iteration this input is being requested under (1-based). */
  iteration: number;
  /** 1-based ask attempt; >1 means the previous answer was rejected. */
  attempt: number;
  /** Rendered instructions / the agent's question, capped for transport. */
  prompt: string;
  /** Pick-one choices (rendered); absent ⇒ free-form text. */
  choices?: string[];
  /** JSON schema the reply must satisfy, when the step declares `output`. */
  outputSchema?: JsonSchema;
  /** Whether this is a spec-declared human step or an agent's question. */
  origin: HumanInputOrigin;
  /** Why the previous attempt's answer was rejected (attempt > 1 only). */
  retryError?: string;
}

/** A human/automated response to a pending {@link HumanInputRequest}. */
export type HumanInputResponse =
  | {
      /** The supplied value (choice text, JSON, or free text). */
      value: string;
      canceled?: false;
      /** Who supplied it — e.g. `"human:tui"`, `"headless:--human"`. */
      by?: string;
    }
  | {
      /** No value will arrive (run canceled, headless with no value, …). */
      canceled: true;
      by?: string;
      /** Human-readable reason recorded on the failed step. */
      reason?: string;
    };

/**
 * Resolves a pending human input. Injected via `WorkflowDeps.requestHumanInput`.
 * The `signal` aborts when the run is cancelled mid-wait; a provider that
 * awaits external input MUST settle when it fires (the engine also races the
 * call against the signal, so a provider that ignores it still unblocks the
 * run — but a well-behaved provider tears down any UI prompt it opened).
 */
export type HumanInputProvider = (
  request: HumanInputRequest,
  signal?: AbortSignal,
) => Promise<HumanInputResponse>;

/** Truncate text to `cap` chars with a visible "[truncated N chars]" marker. */
export function capHumanInputText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [truncated ${text.length - cap} chars]`;
}

/** The outcome of validating a supplied value against a step's contract. */
export type HumanInputValidation =
  | { ok: true; output: string; json?: unknown }
  | { ok: false; error: string };

/**
 * Validate a supplied value against the step's contract:
 *
 *  - with `choices`: the trimmed value must equal one choice exactly — or be a
 *    1-based index (`"2"` picks the second choice) when no choice IS that
 *    literal text, so CLI answers stay ergonomic without ambiguity;
 *  - with an `outputSchema`: the value must contain JSON matching the schema
 *    (fenced or raw); the canonical serialization becomes the step output so
 *    `output` and `json` always agree;
 *  - otherwise: any non-blank text, recorded verbatim (trimmed).
 */
export function validateHumanInputValue(
  value: string,
  contract: { choices?: string[]; outputSchema?: JsonSchema },
): HumanInputValidation {
  const trimmed = value.trim();
  if (contract.choices && contract.choices.length > 0) {
    const exact = contract.choices.find((choice) => choice === trimmed);
    if (exact !== undefined) return { ok: true, output: exact };
    if (/^\d+$/.test(trimmed)) {
      const index = Number(trimmed);
      if (index >= 1 && index <= contract.choices.length) {
        return { ok: true, output: contract.choices[index - 1] as string };
      }
    }
    return {
      ok: false,
      error: `answer must be one of the choices (or a 1-based number): ${contract.choices
        .map((choice, i) => `${i + 1}) ${choice}`)
        .join("  ")}`,
    };
  }
  if (contract.outputSchema) {
    const parsed = parseStructuredOutput(value, contract.outputSchema);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, output: JSON.stringify(parsed.value), json: parsed.value };
  }
  if (!trimmed) return { ok: false, error: "answer must not be empty" };
  return { ok: true, output: trimmed };
}

/**
 * Find the pending input matching a response against a list of pending inputs
 * (the live-run registry's `pendingInputs`). The list carries NAMESPACED step
 * ids (`parent::child`) when the step lives inside a sub-workflow, while a
 * responder may pass either form — the same matching rule as approvals.
 */
export function matchPendingInput<T extends { stepId: string; iteration: number }>(
  pending: readonly T[],
  stepId: string,
  iteration?: number,
): T | undefined {
  return pending.find(
    (p) =>
      (p.stepId === stepId || p.stepId.endsWith(`::${stepId}`)) &&
      (iteration === undefined || p.iteration === iteration),
  );
}

/**
 * A non-interactive {@link HumanInputProvider} for CI / headless runs, backed
 * by `--human <stepId>=<value|@file>` values. A request whose step has a
 * supplied value resolves immediately; anything else cancels with guidance —
 * a pipeline never hangs on a question nobody is there to answer.
 *
 * Lookup accepts the step's local id or, for sub-workflow steps, the trailing
 * `::`-segment of the namespaced id.
 */
export function headlessHumanInputProvider(values: Record<string, string>): HumanInputProvider {
  return async (request): Promise<HumanInputResponse> => {
    const local = request.stepId.includes("::")
      ? request.stepId.slice(request.stepId.lastIndexOf("::") + 2)
      : request.stepId;
    const value = values[request.stepId] ?? values[local];
    if (value !== undefined) {
      return { value, by: "headless:--human" };
    }
    const what =
      request.origin === "agent-question"
        ? `the agent asked: ${firstLineOf(request.prompt)}`
        : "this step needs a human answer";
    return {
      canceled: true,
      by: "auto:no-value",
      reason: `${what} — supply one with --human ${local}=<value|@file>, or use --detach and answer from any attached UI ('steamtrain workflow answer')`,
    };
  };
}

/**
 * The engine's fallback when a run reaches a human step but no provider was
 * injected (misconfiguration, or an old caller). Cancels with guidance rather
 * than hanging.
 */
export function noProviderHumanInputResponse(request: HumanInputRequest): HumanInputResponse {
  return {
    canceled: true,
    by: "auto:no-provider",
    reason:
      request.origin === "agent-question"
        ? "the agent asked a clarifying question but no human-input provider is configured"
        : "no human-input provider configured for this run",
  };
}

function firstLineOf(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
