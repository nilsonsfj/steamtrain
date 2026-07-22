import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { API_PROVIDER_IDS, apiScopeLabel } from "../apis";
import type { ResolvedApiInstance } from "../apis";
import type { ApiConfigScope } from "../config/types";
import type { ApiDoctorResult, ApiDoctorStatus } from "../doctor";
import type { ApiProviderId } from "../types/events";
import { shouldAcceptTextInput } from "./text-input-filter";
import { API_STATUS_STYLE } from "./theme";
import { selectVisibleWindow } from "./workflow-list-window";

/** Fuller readiness labels for the manager (the status bar uses terse ones). */
const HEALTH_LABEL: Record<ApiDoctorStatus, string> = {
  ok: "ready",
  key_missing: "no key",
  not_authenticated: "key rejected",
  unreachable: "unreachable",
  unknown_error: "error",
};

export interface ApiMutationResult {
  ok: boolean;
  error?: string;
  /** Success feedback (e.g. the file written). */
  text?: string;
}

export interface ApiAddRequest {
  id: string;
  provider: ApiProviderId;
  baseUrl?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  scope: ApiConfigScope;
}

interface ApiManagerProps {
  /** All resolved API instances including disabled ones. */
  apis: ResolvedApiInstance[];
  /** Config scope by instance id; absent = unconfigured built-in. */
  scopes: ReadonlyMap<string, ApiConfigScope>;
  /** False when running with a custom --config file (no global layer). */
  canGlobal: boolean;
  /** Live readiness per API instance; null while the first probe is running. */
  apiDoctor?: ApiDoctorResult[] | null;
  width: number;
  height: number;
  onToggle: (id: string) => ApiMutationResult;
  onAdd: (request: ApiAddRequest) => ApiMutationResult;
  onDelete: (id: string) => ApiMutationResult;
  /** Re-run the API readiness probes for the current instances (bound to `r`). */
  onRecheck?: () => void;
  onClose: () => void;
}

interface AddFormState {
  field: "id" | "provider" | "baseUrl" | "apiKeyEnv" | "defaultModel" | "scope";
  id: string;
  providerIndex: number;
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
  scope: ApiConfigScope;
}

type Message = { level: "info" | "error"; text: string } | null;

const ADD_FIELDS: AddFormState["field"][] = [
  "id",
  "provider",
  "baseUrl",
  "apiKeyEnv",
  "defaultModel",
  "scope",
];

/**
 * Full-screen API manager for direct-inference `llm` steps: list configured
 * API endpoint instances across global (`~/.steamtrain/config.json`) and
 * project (`steamtrain.json`) scopes, toggle, add, or delete entries — the
 * exact analog of the agent manager. Opened via `/apis`.
 */
export function ApiManager({
  apis,
  scopes,
  canGlobal,
  apiDoctor,
  width,
  height,
  onToggle,
  onAdd,
  onDelete,
  onRecheck,
  onClose,
}: ApiManagerProps) {
  const [index, setIndex] = useState(0);
  const [form, setForm] = useState<AddFormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const clamped = Math.min(index, Math.max(0, apis.length - 1));
  const selected = apis[clamped];

  const healthById = useMemo(() => {
    const map = new Map<string, ApiDoctorResult>();
    for (const result of apiDoctor ?? []) map.set(result.api, result);
    return map;
  }, [apiDoctor]);
  const selectedHealth = selected ? healthById.get(selected.id) : undefined;
  const fix =
    selectedHealth && selectedHealth.status !== "ok" && selectedHealth.detail
      ? { detail: selectedHealth.detail, command: selectedHealth.fixCommand }
      : null;

  useInput((input, key) => {
    if (form) {
      handleFormInput(input, key);
      return;
    }
    if (confirmDelete) {
      if (input === "y" || input === "Y") {
        setMessage(toMessage(onDelete(confirmDelete)));
        setConfirmDelete(null);
        setIndex((i) => Math.max(0, Math.min(i, apis.length - 2)));
      } else if (key.escape || input === "n" || input === "N") {
        setConfirmDelete(null);
      }
      return;
    }
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setIndex(Math.max(0, clamped - 1));
      return;
    }
    if (key.downArrow) {
      setIndex(Math.min(Math.max(0, apis.length - 1), clamped + 1));
      return;
    }
    if ((key.return || input === " ") && selected) {
      setMessage(toMessage(onToggle(selected.id)));
      return;
    }
    if (input === "r" && onRecheck) {
      onRecheck();
      setMessage({ level: "info", text: "rechecking API readiness…" });
      return;
    }
    if (input === "a") {
      setForm({
        field: "id",
        id: "",
        providerIndex: 0,
        baseUrl: "",
        apiKeyEnv: "",
        defaultModel: "",
        scope: canGlobal ? "user" : "project",
      });
      setMessage(null);
      return;
    }
    if (input === "d" && selected) {
      if (!scopes.has(selected.id)) {
        setMessage({
          level: "error",
          text: `'${selected.id}' is a built-in default (not configured); disable it instead`,
        });
        return;
      }
      setConfirmDelete(selected.id);
    }
  });

  function handleFormInput(input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) {
    if (!form) return;
    if (key.escape) {
      setForm(null);
      return;
    }
    if (key.return) {
      const at = ADD_FIELDS.indexOf(form.field);
      if (form.field === "id" && form.id.trim().length === 0) {
        setMessage({ level: "error", text: "api id must not be empty" });
        return;
      }
      if (at < ADD_FIELDS.length - 1) {
        setForm({ ...form, field: ADD_FIELDS[at + 1]! });
        return;
      }
      const provider = API_PROVIDER_IDS[form.providerIndex]!;
      const baseUrl = form.baseUrl.trim();
      const apiKeyEnv = form.apiKeyEnv.trim();
      const defaultModel = form.defaultModel.trim();
      const result = onAdd({
        id: form.id.trim(),
        provider,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
        ...(defaultModel ? { defaultModel } : {}),
        scope: form.scope,
      });
      setMessage(toMessage(result));
      if (result.ok) setForm(null);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const at = ADD_FIELDS.indexOf(form.field);
      const next = key.upArrow ? Math.max(0, at - 1) : Math.min(ADD_FIELDS.length - 1, at + 1);
      setForm({ ...form, field: ADD_FIELDS[next]! });
      return;
    }
    if (form.field === "provider" && (key.leftArrow || key.rightArrow)) {
      const delta = key.leftArrow ? -1 : 1;
      const count = API_PROVIDER_IDS.length;
      setForm({ ...form, providerIndex: (form.providerIndex + delta + count) % count });
      return;
    }
    if (form.field === "scope" && (key.leftArrow || key.rightArrow)) {
      if (!canGlobal) {
        setMessage({ level: "error", text: "global scope unavailable with a custom --config" });
        return;
      }
      setForm({ ...form, scope: form.scope === "user" ? "project" : "user" });
      return;
    }
    if (
      form.field === "id" ||
      form.field === "baseUrl" ||
      form.field === "apiKeyEnv" ||
      form.field === "defaultModel"
    ) {
      const fieldKey = form.field;
      if (key.backspace || key.delete) {
        setForm({ ...form, [fieldKey]: form[fieldKey].slice(0, -1) });
        return;
      }
      if (shouldAcceptTextInput(input, key) && !key.tab) {
        setForm({ ...form, [fieldKey]: form[fieldKey] + input });
      }
    }
  }

  const fixHeight = form ? 0 : fix ? (fix.command ? 2 : 1) : 0;
  const listBudget = Math.max(1, height - 4 - (message ? 1 : 0) - fixHeight);
  const window = selectVisibleWindow(apis, clamped, listBudget);
  const readySummary = summarizeReadiness(apiDoctor);
  const closeHint = onRecheck
    ? "↑/↓ select · Enter toggle · a add · d delete · r recheck · Esc close"
    : "↑/↓ select · Enter/Space toggle · a add · d delete · Esc close";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan" bold>
            apis
          </Text>
          {readySummary ? (
            <Text color="gray">
              {"  "}
              {readySummary}
            </Text>
          ) : null}
        </Box>
        <Text color="gray">
          {form
            ? "↑/↓ field · ←/→ choose · Enter next/save · Esc cancel"
            : confirmDelete
              ? `delete '${confirmDelete}'? y/n`
              : closeHint}
        </Text>
      </Box>
      {form ? (
        <AddForm form={form} canGlobal={canGlobal} />
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {window.hiddenBefore > 0 ? (
            <Text color="gray">{window.hiddenBefore} earlier hidden ↑</Text>
          ) : null}
          {window.visible.map((api, offset) => (
            <ApiRow
              key={api.id}
              api={api}
              scope={scopes.get(api.id)}
              health={api.enabled ? healthById.get(api.id) : undefined}
              selected={window.start + offset === clamped}
              width={Math.max(20, width - 4)}
            />
          ))}
          {window.hiddenAfter > 0 ? (
            <Text color="gray">{window.hiddenAfter} later hidden ↓</Text>
          ) : null}
        </Box>
      )}
      {fix && selected ? (
        <Box flexDirection="column">
          <Text color="yellow" wrap="truncate-end">
            fix {selected.id}: {fix.detail}
          </Text>
          {fix.command ? (
            <Text color="cyan">
              {"  $ "}
              {fix.command}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {message ? (
        <Text color={message.level === "error" ? "red" : "green"} wrap="truncate-end">
          {message.text}
        </Text>
      ) : null}
    </Box>
  );
}

/** Compact per-problem words for the header summary (rows show the full label). */
const SHORT_HEALTH_LABEL: Record<ApiDoctorStatus, string> = {
  ok: "ready",
  key_missing: "no key",
  not_authenticated: "rejected",
  unreachable: "offline",
  unknown_error: "error",
};

/** "2/4 ready · 1 no key" — null while the first probe is still running. */
function summarizeReadiness(apiDoctor: ApiDoctorResult[] | null | undefined): string | null {
  if (!apiDoctor || apiDoctor.length === 0) return apiDoctor === null ? "checking…" : null;
  const counts = new Map<ApiDoctorStatus, number>();
  for (const result of apiDoctor) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  const parts = [`${counts.get("ok") ?? 0}/${apiDoctor.length} ready`];
  const problems: ApiDoctorStatus[] = [
    "not_authenticated",
    "unreachable",
    "unknown_error",
    "key_missing",
  ];
  for (const status of problems) {
    const n = counts.get(status);
    if (n) parts.push(`${n} ${SHORT_HEALTH_LABEL[status]}`);
  }
  return parts.join(" · ");
}

function ApiRow({
  api,
  scope,
  health,
  selected,
  width: _width,
}: {
  api: ResolvedApiInstance;
  scope: ApiConfigScope | undefined;
  health: ApiDoctorResult | undefined;
  selected: boolean;
  width: number;
}) {
  const state = api.enabled ? { symbol: "●", color: "green" } : { symbol: "○", color: "gray" };
  const keyPresent = Boolean(process.env[api.apiKeyEnv]);
  const provider = api.provider === api.id ? "" : ` provider=${api.provider}`;
  const baseUrl = api.baseUrl ? ` baseUrl=${api.baseUrl}` : "";
  const key = ` key=${api.apiKeyEnv}${keyPresent ? "" : " (unset)"}`;
  const model = api.defaultModel ? ` model=${api.defaultModel}` : "";
  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
      <Text color={state.color}>{state.symbol} </Text>
      <Text color={selected ? "cyan" : "white"} bold={selected}>
        {api.id}
      </Text>
      {health ? (
        <Text color={API_STATUS_STYLE[health.status].color}> {HEALTH_LABEL[health.status]}</Text>
      ) : null}
      <Text color="gray" wrap="truncate-end">
        {"  "}
        {apiScopeLabel(scope)}
        {api.enabled ? "" : " disabled"}
        {provider}
        {key}
        {baseUrl}
        {model}
      </Text>
    </Box>
  );
}

function AddForm({ form, canGlobal }: { form: AddFormState; canGlobal: boolean }) {
  const provider = API_PROVIDER_IDS[form.providerIndex] ?? API_PROVIDER_IDS[0];
  const rows: Array<{ field: AddFormState["field"]; label: string; value: string; hint?: string }> =
    [
      { field: "id", label: "id", value: form.id || "…", hint: "instance id (e.g. groq)" },
      { field: "provider", label: "provider", value: `◀ ${provider} ▶` },
      {
        field: "baseUrl",
        label: "baseUrl",
        value: form.baseUrl || "(provider default)",
        hint: "optional endpoint (openai style: include /v1)",
      },
      {
        field: "apiKeyEnv",
        label: "key env",
        value: form.apiKeyEnv || "(provider default)",
        hint: "optional env var holding the API key",
      },
      {
        field: "defaultModel",
        label: "model",
        value: form.defaultModel || "(none)",
        hint: "optional default model for steps on this api",
      },
      {
        field: "scope",
        label: "scope",
        value:
          form.scope === "user"
            ? "◀ global (~/.steamtrain/config.json) ▶"
            : canGlobal
              ? "◀ project (steamtrain.json) ▶"
              : "project (steamtrain.json)",
      },
    ];
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color="gray">add api</Text>
      {rows.map((row) => (
        <Box key={row.field}>
          <Text color={form.field === row.field ? "cyan" : "gray"}>
            {form.field === row.field ? "▶ " : "  "}
            {row.label.padEnd(9)}
          </Text>
          <Text color={form.field === row.field ? "white" : "gray"}>{row.value}</Text>
          {row.hint && form.field === row.field ? <Text color="gray"> — {row.hint}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function toMessage(result: ApiMutationResult): Message {
  if (!result.ok) return { level: "error", text: result.error ?? "operation failed" };
  return result.text ? { level: "info", text: result.text } : null;
}
