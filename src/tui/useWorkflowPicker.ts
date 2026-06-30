import { homedir } from "node:os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DoctorResult } from "../doctor";
import type { Orchestrator } from "../orchestrator";
import { homeRelativePath } from "../paths";
import type {
  LoadedWorkflowCatalog,
  WorkflowAuthor,
  WorkflowCatalogEntry,
  WorkflowScope,
  WorkflowSpec,
  WorkflowStepOverrides,
} from "../workflow";
import { isAgentBackedStep, workflowCatalogEntries } from "../workflow";
import type { WorkspaceEntry } from "../workspace";
import type { WorkflowCreateState } from "./WorkflowCreate";
import type { DraftTarget } from "./draft-model";
import { healthyAgentSet, resolveDraftTarget } from "./draft-model";
import type { Mode } from "./modes";
import type { TranscriptAction } from "./transcript";
import { flattenSpecSteps } from "./workflow-spec-ui";

export interface UseWorkflowPickerParams {
  mode: Mode;
  doctor: DoctorResult[] | null;
  runtimeCatalog: LoadedWorkflowCatalog;
  orchestrator: Orchestrator;
  author: WorkflowAuthor;
  running: boolean;
  mountedRef: React.RefObject<boolean>;
  dispatch: React.Dispatch<TranscriptAction>;
  wfStepOverrides: Record<string, WorkflowStepOverrides>;
  setWfStepOverrides: React.Dispatch<React.SetStateAction<Record<string, WorkflowStepOverrides>>>;
  resolveWorkflowSpec: (name: string) => WorkflowSpec | undefined;
}

export function useWorkflowPicker({
  mode,
  doctor,
  runtimeCatalog,
  orchestrator,
  author,
  running,
  mountedRef,
  dispatch,
  wfStepOverrides,
  setWfStepOverrides,
  resolveWorkflowSpec,
}: UseWorkflowPickerParams) {
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [wfPreview, setWfPreview] = useState<{ name: string; input: string } | null>(null);
  const [wfCreate, setWfCreate] = useState<WorkflowCreateState | null>(null);
  const [draftOverride, setDraftOverride] = useState<DraftTarget | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const pendingSelectRef = useRef<string | null>(null);
  const createAbortRef = useRef<AbortController | null>(null);

  const workflowEntries = useMemo<WorkflowCatalogEntry[]>(
    () => workflowCatalogEntries(runtimeCatalog),
    [runtimeCatalog],
  );

  const onCreateRow = workflowIndex >= workflowEntries.length;
  const selectedWorkflowName = onCreateRow
    ? undefined
    : workflowEntries[Math.min(workflowIndex, Math.max(0, workflowEntries.length - 1))]?.name;
  const userWorkflowNames = useMemo(
    () =>
      workflowEntries
        .filter((entry) => entry.source === "user" || entry.source === "project")
        .map((entry) => entry.name),
    [workflowEntries],
  );

  // Keep the picker selection in range and honor a queued post-write selection.
  useEffect(() => {
    const pending = pendingSelectRef.current;
    if (pending) {
      const idx = workflowEntries.findIndex((entry) => entry.name === pending);
      if (idx >= 0) {
        pendingSelectRef.current = null;
        setWorkflowIndex(idx);
        return;
      }
    }
    setWorkflowIndex((i) => Math.min(i, workflowEntries.length));
  }, [workflowEntries]);

  const config = orchestrator.getConfig();
  const healthyAgents = useMemo(() => healthyAgentSet(doctor), [doctor]);
  const draftResolution = useMemo(
    () => resolveDraftTarget(healthyAgents, draftOverride, config),
    [healthyAgents, draftOverride, config],
  );

  const patchWorkflowStep = useCallback(
    (
      stepId: string,
      patch: Partial<
        Pick<WorkspaceEntry, "agent" | "model" | "effort"> & {
          prompt?: string;
          stepTimeoutSec?: number;
          cwd?: string;
          env?: Record<string, string>;
          extraArgs?: string[];
        }
      >,
    ) => {
      if (!wfPreview) return;
      setWfStepOverrides((prev) => ({
        ...prev,
        [wfPreview.name]: {
          ...(prev[wfPreview.name] ?? {}),
          [stepId]: { ...(prev[wfPreview.name]?.[stepId] ?? {}), ...patch },
        },
      }));
    },
    [wfPreview, setWfStepOverrides],
  );

  // Preview derivations.
  const previewSpec = wfPreview ? resolveWorkflowSpec(wfPreview.name) : undefined;
  const previewFlatSteps = useMemo(
    () => (previewSpec ? flattenSpecSteps(previewSpec) : []),
    [previewSpec],
  );
  const previewStepCount = previewFlatSteps.length;
  const previewDispatchCheck = previewSpec
    ? orchestrator.canDispatchWorkflowSpec(previewSpec)
    : null;

  const cloneWorkflow = useCallback(
    async (newName: string, scope: WorkflowScope = "user") => {
      const source = wfPreview?.name ?? selectedWorkflowName;
      if (!source) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "no workflow selected to clone" }],
        };
      }
      const result = await author.clone(source, newName, scope);
      if (!result.ok) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not clone '${source}': ${result.error}` },
          ],
        };
      }
      pendingSelectRef.current = result.name ?? null;
      const where = scope === "project" ? " (project)" : "";
      return {
        handled: true as const,
        clearInput: true,
        notices: [
          { level: "info" as const, text: `cloned '${source}' → '${result.name}'${where}` },
        ],
      };
    },
    [author, selectedWorkflowName, wfPreview],
  );

  const deleteWorkflow = useCallback(
    async (name: string) => {
      const result = await author.remove(name);
      if (!result.ok) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not delete '${name}': ${result.error}` },
          ],
        };
      }
      setWfStepOverrides((prev) => {
        if (!prev[name]) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setWfPreview((prev) => (prev?.name === name ? null : prev));
      return {
        handled: true as const,
        clearInput: true,
        notices: [{ level: "info" as const, text: `deleted workflow '${name}'` }],
      };
    },
    [author, setWfStepOverrides],
  );

  const renameWorkflow = useCallback(
    async (oldName: string, newName: string) => {
      if (running) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "cannot rename while a workflow is running" }],
        };
      }

      const source = oldName.trim() || wfPreview?.name || selectedWorkflowName;
      if (!source) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "no workflow selected to rename" }],
        };
      }

      const result = await author.rename(source, newName);
      if (!result.ok) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not rename '${source}': ${result.error}` },
          ],
        };
      }

      const targetSlug = result.name;
      if (!targetSlug) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not rename '${source}': missing target name` },
          ],
        };
      }

      setWfStepOverrides((prev) => migrateSessionOverrides(prev, source, targetSlug));
      setWfPreview((prev) => updatePreviewOnRename(prev, source, targetSlug));
      pendingSelectRef.current = targetSlug;

      return {
        handled: true as const,
        clearInput: true,
        notices: [
          { level: "info" as const, text: `renamed workflow '${source}' → '${targetSlug}'` },
        ],
      };
    },
    [author, selectedWorkflowName, wfPreview, running, setWfStepOverrides],
  );

  const updateWorkflowDescription = useCallback(
    async (name: string, description: string) => {
      if (running) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "cannot edit while a workflow is running" }],
        };
      }

      const workflowName = name.trim() || wfPreview?.name;
      if (!workflowName) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "no workflow selected" }],
        };
      }

      const spec = resolveWorkflowSpec(workflowName);
      if (!spec) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "error" as const, text: `workflow '${workflowName}' not found` }],
        };
      }

      const source = runtimeCatalog.sources[workflowName];
      const scope = source === "user" || source === "project" ? source : "user";
      const updatedSpec = { ...spec, description };
      const result = await author.save(workflowName, updatedSpec, undefined, scope);
      if (!result.ok) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not update description: ${result.error}` },
          ],
        };
      }

      setCatalogVersion((v) => v + 1);
      return {
        handled: true as const,
        clearInput: true,
        notices: [
          {
            level: "info" as const,
            text: `description updated for '${workflowName}' (${description.length} chars)`,
          },
        ],
      };
    },
    [author, resolveWorkflowSpec, runtimeCatalog, wfPreview, running],
  );

  const saveWorkflows = useCallback(async () => {
    const home = homedir();
    const result = await author.flushSessionOverrides(wfStepOverrides);

    if (result.saved.length === 0) {
      const notices: Array<{ level: "info" | "warn"; text: string }> = [
        { level: "info", text: "no workflow changes to save" },
      ];
      for (const entry of result.skipped) {
        notices.push({ level: "warn", text: `skipped '${entry.name}': ${entry.reason}` });
      }
      return { handled: true as const, clearInput: true, notices };
    }

    setWfStepOverrides((prev) => {
      const next = { ...prev };
      for (const name of result.saved) delete next[name];
      return next;
    });

    const notices: Array<{ level: "info" | "warn"; text: string }> = [
      {
        level: "info",
        text: `saved ${result.saved.join(", ")} to ${homeRelativePath(result.path!, home)}`,
      },
    ];
    for (const entry of result.skipped) {
      notices.push({ level: "warn", text: `skipped '${entry.name}': ${entry.reason}` });
    }
    return { handled: true as const, clearInput: true, notices };
  }, [author, wfStepOverrides, setWfStepOverrides]);

  const createWorkflow = useCallback(
    (description: string, scope: WorkflowScope = "user") => {
      if (running) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            {
              level: "warn" as const,
              text: "finish or cancel the current run before creating a workflow",
            },
          ],
        };
      }
      const target = draftResolution.target;
      if (!target) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            {
              level: "error" as const,
              text: "no healthy agent available to draft a workflow (check the doctor panel)",
            },
          ],
        };
      }

      createAbortRef.current?.abort();
      const ac = new AbortController();
      createAbortRef.current = ac;
      setWfCreate({
        status: "generating",
        description,
        agent: target.agent,
        model: target.model,
        text: "",
      });

      void (async () => {
        const result = await author.generate(
          { description, agent: target.agent, model: target.model, scope },
          (text) => {
            setWfCreate((prev) =>
              prev && prev.status === "generating" ? { ...prev, text: prev.text + text } : prev,
            );
          },
          ac.signal,
          (attempt) => {
            if (attempt <= 1) return;
            setWfCreate((prev) =>
              prev && prev.status === "generating" ? { ...prev, text: "" } : prev,
            );
          },
        );
        if (!mountedRef.current || ac.signal.aborted) return;

        if (!result.ok || !result.spec) {
          setWfCreate((prev) =>
            prev
              ? { ...prev, status: "error", error: result.error, text: result.raw || prev.text }
              : prev,
          );
          dispatch({
            type: "notice",
            level: "error",
            text: `workflow creation failed: ${result.error ?? "unknown error"}`,
          });
          return;
        }

        const spec = result.spec;
        pendingSelectRef.current = spec.name;
        setWfCreate((prev) =>
          prev
            ? { ...prev, status: "done", spec, savedPath: result.savedPath, error: undefined }
            : prev,
        );
        dispatch({
          type: "notice",
          level: "info",
          text: `created workflow '${spec.name}' (${result.replaced ? "updated" : "saved"}${
            scope === "project" ? ", project" : ""
          })`,
        });
      })();

      return {
        handled: true as const,
        clearInput: true,
        notices: [
          {
            level: "info" as const,
            text: `drafting workflow with ${target.agent} (${target.model})…`,
          },
        ],
      };
    },
    [running, draftResolution, author, mountedRef, dispatch],
  );

  return {
    workflowIndex,
    setWorkflowIndex,
    wfPreview,
    setWfPreview,
    wfCreate,
    setWfCreate,
    draftOverride,
    setDraftOverride,
    pendingSelectRef,
    createAbortRef,
    workflowEntries,
    onCreateRow,
    selectedWorkflowName,
    userWorkflowNames,
    healthyAgents,
    draftResolution,
    patchWorkflowStep,
    cloneWorkflow,
    deleteWorkflow,
    renameWorkflow,
    updateWorkflowDescription,
    saveWorkflows,
    createWorkflow,
    preview: {
      spec: previewSpec,
      flatSteps: previewFlatSteps,
      stepCount: previewStepCount,
      dispatchCheck: previewDispatchCheck,
    },
  };
}

/**
 * Migrate session overrides from an old workflow name to a new one.
 *
 * NOTE: Returning `prev` by reference when no migration is needed is an intentional
 * React state updater optimization to prevent unnecessary component re-renders.
 */
export function migrateSessionOverrides(
  prev: Record<string, WorkflowStepOverrides>,
  source: string,
  targetSlug: string,
): Record<string, WorkflowStepOverrides> {
  if (!prev[source]) return prev;
  const next = { ...prev };
  next[targetSlug] = next[source]!;
  delete next[source];
  return next;
}

/**
 * Update the preview state if the renamed workflow was being previewed.
 */
export function updatePreviewOnRename(
  prev: { name: string; input: string } | null,
  source: string,
  targetSlug: string,
): { name: string; input: string } | null {
  return prev?.name === source ? { name: targetSlug, input: prev.input } : prev;
}
