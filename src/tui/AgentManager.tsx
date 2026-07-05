import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { AGENT_IDS, agentScopeLabel } from "../agents";
import type { ResolvedAgentInstance } from "../agents";
import type { AgentConfigScope, AgentInstanceConfig } from "../config/types";
import type { AgentProviderId } from "../types/events";
import { selectVisibleWindow } from "./workflow-list-window";

export interface AgentMutationResult {
  ok: boolean;
  error?: string;
  /** Success feedback (e.g. the file written). */
  text?: string;
}

export interface AgentAddRequest {
  id: string;
  provider: AgentProviderId;
  binary?: string;
  scope: AgentConfigScope;
}

interface AgentManagerProps {
  /** All resolved agents including disabled ones. */
  agents: ResolvedAgentInstance[];
  /** Config scope by agent id; absent = unconfigured built-in. */
  scopes: ReadonlyMap<string, AgentConfigScope>;
  /** False when running with a custom --config file (no global layer). */
  canGlobal: boolean;
  width: number;
  height: number;
  onToggle: (id: string) => AgentMutationResult;
  onAdd: (request: AgentAddRequest) => AgentMutationResult;
  onDelete: (id: string) => AgentMutationResult;
  onClose: () => void;
}

interface AddFormState {
  field: "id" | "provider" | "binary" | "scope";
  id: string;
  providerIndex: number;
  binary: string;
  scope: AgentConfigScope;
}

type Message = { level: "info" | "error"; text: string } | null;

const ADD_FIELDS: AddFormState["field"][] = ["id", "provider", "binary", "scope"];

/**
 * Full-screen agent manager: list configured agents across global
 * (`~/.steamtrain/config.json`) and project (`steamtrain.json`) scopes,
 * toggle, add, or delete entries. Opened via `/agents` or Ctrl+A.
 */
export function AgentManager({
  agents,
  scopes,
  canGlobal,
  width,
  height,
  onToggle,
  onAdd,
  onDelete,
  onClose,
}: AgentManagerProps) {
  const [index, setIndex] = useState(0);
  const [form, setForm] = useState<AddFormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const clamped = Math.min(index, Math.max(0, agents.length - 1));
  const selected = agents[clamped];

  useInput((input, key) => {
    if (form) {
      handleFormInput(input, key);
      return;
    }
    if (confirmDelete) {
      if (input === "y" || input === "Y") {
        setMessage(toMessage(onDelete(confirmDelete)));
        setConfirmDelete(null);
        setIndex((i) => Math.max(0, Math.min(i, agents.length - 2)));
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
      setIndex(Math.min(Math.max(0, agents.length - 1), clamped + 1));
      return;
    }
    if ((key.return || input === " ") && selected) {
      setMessage(toMessage(onToggle(selected.id)));
      return;
    }
    if (input === "a") {
      setForm({
        field: "id",
        id: "",
        providerIndex: 0,
        binary: "",
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
        setMessage({ level: "error", text: "agent id must not be empty" });
        return;
      }
      if (at < ADD_FIELDS.length - 1) {
        setForm({ ...form, field: ADD_FIELDS[at + 1]! });
        return;
      }
      const provider = AGENT_IDS[form.providerIndex]!;
      const binary = form.binary.trim();
      const result = onAdd({
        id: form.id.trim(),
        provider,
        ...(binary ? { binary } : {}),
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
      const count = AGENT_IDS.length;
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
    if (form.field === "id" || form.field === "binary") {
      const fieldKey = form.field;
      if (key.backspace || key.delete) {
        setForm({ ...form, [fieldKey]: form[fieldKey].slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setForm({ ...form, [fieldKey]: form[fieldKey] + input });
      }
    }
  }

  const listBudget = Math.max(1, height - (message ? 5 : 4));
  const window = selectVisibleWindow(agents, clamped, listBudget);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          agents
        </Text>
        <Text color="gray">
          {form
            ? "↑/↓ field · ←/→ choose · Enter next/save · Esc cancel"
            : confirmDelete
              ? `delete '${confirmDelete}'? y/n`
              : "↑/↓ select · Enter/Space toggle · a add · d delete · Esc close"}
        </Text>
      </Box>
      {form ? (
        <AddForm form={form} canGlobal={canGlobal} />
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {window.hiddenBefore > 0 ? (
            <Text color="gray">{window.hiddenBefore} earlier hidden ↑</Text>
          ) : null}
          {window.visible.map((agent, offset) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              scope={scopes.get(agent.id)}
              selected={window.start + offset === clamped}
              width={Math.max(20, width - 4)}
            />
          ))}
          {window.hiddenAfter > 0 ? (
            <Text color="gray">{window.hiddenAfter} later hidden ↓</Text>
          ) : null}
        </Box>
      )}
      {message ? (
        <Text color={message.level === "error" ? "red" : "green"} wrap="truncate-end">
          {message.text}
        </Text>
      ) : null}
    </Box>
  );
}

function AgentRow({
  agent,
  scope,
  selected,
  width,
}: {
  agent: ResolvedAgentInstance;
  scope: AgentConfigScope | undefined;
  selected: boolean;
  width: number;
}) {
  const state = agent.enabled ? { symbol: "●", color: "green" } : { symbol: "○", color: "gray" };
  const provider = agent.provider === agent.id ? "" : ` provider=${agent.provider}`;
  const model = agent.defaultModel ? ` model=${agent.defaultModel}` : "";
  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
      <Text color={state.color}>{state.symbol} </Text>
      <Text color={selected ? "cyan" : "white"} bold={selected}>
        {agent.id}
      </Text>
      <Text color="gray" wrap="truncate-end">
        {"  "}
        {agentScopeLabel(scope)}
        {agent.enabled ? "" : " disabled"}
        {provider} binary={agent.binary}
        {model}
      </Text>
    </Box>
  );
}

function AddForm({ form, canGlobal }: { form: AddFormState; canGlobal: boolean }) {
  const provider = AGENT_IDS[form.providerIndex] ?? AGENT_IDS[0];
  const rows: Array<{ field: AddFormState["field"]; label: string; value: string; hint?: string }> =
    [
      { field: "id", label: "id", value: form.id || "…", hint: "instance id (e.g. mimocode)" },
      { field: "provider", label: "provider", value: `◀ ${provider} ▶` },
      {
        field: "binary",
        label: "binary",
        value: form.binary || "(provider default)",
        hint: "optional binary path/name",
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
      <Text color="gray">add agent</Text>
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

function toMessage(result: AgentMutationResult): Message {
  if (!result.ok) return { level: "error", text: result.error ?? "operation failed" };
  return result.text ? { level: "info", text: result.text } : null;
}
