import { Box, Text, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";
import type { WorkflowInputSpec, WorkflowInputType, WorkflowSpec } from "../workflow";
import { resolveInputs, workflowInputType } from "../workflow";

interface Field {
  key: string;
  spec: WorkflowInputSpec;
  type: WorkflowInputType;
  value: string;
}

export interface WorkflowInputFormProps {
  spec: WorkflowSpec;
  width: number;
  height: number;
  onSubmit: (params: Record<string, string | number | boolean>) => void;
  onCancel: () => void;
  /** Catalog suggestions for `type: "model"` fields (Tab completes). */
  modelSuggestions?: readonly string[];
  /** Catalog suggestions for `type: "agent"` fields (Tab completes / cycles). */
  agentSuggestions?: readonly string[];
}

const BOOLEAN_OPTIONS = [
  { value: "true", label: "yes" },
  { value: "false", label: "no" },
];

function defaultFieldValue(spec: WorkflowInputSpec): string {
  if (spec.default !== undefined) return String(spec.default);
  return "";
}

function filterSuggestions(candidates: readonly string[], query: string): string[] {
  const lower = query.toLowerCase();
  if (!lower) return [...candidates];
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (cl.startsWith(lower)) prefix.push(c);
    else if (cl.includes(lower)) contains.push(c);
  }
  return [...prefix, ...contains];
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

function choicesForField(
  field: Field,
  modelSuggestions: readonly string[],
  agentSuggestions: readonly string[],
): string[] {
  if (field.spec.choices && field.spec.choices.length > 0) {
    return [...field.spec.choices];
  }
  if (field.type === "boolean") return BOOLEAN_OPTIONS.map((o) => o.value);
  if (field.type === "model") return [...modelSuggestions];
  if (field.type === "agent") return [...agentSuggestions];
  return [];
}

function typeHint(type: WorkflowInputType): string {
  switch (type) {
    case "boolean":
      return "(y/n)";
    case "number":
      return "(number)";
    case "model":
      return "(model)";
    case "agent":
      return "(agent)";
    case "enum":
      return "(enum)";
    default:
      return "";
  }
}

function cycleValue(choices: string[], current: string, direction: 1 | -1): string {
  if (choices.length === 0) return current;
  const idx = choices.findIndex((c) => c === current);
  if (idx < 0)
    return direction === 1 ? (choices[0] ?? current) : (choices[choices.length - 1] ?? current);
  const next = (idx + direction + choices.length) % choices.length;
  return choices[next] ?? current;
}

export function WorkflowInputForm({
  spec,
  width,
  height,
  onSubmit,
  onCancel,
  modelSuggestions = [],
  agentSuggestions = [],
}: WorkflowInputFormProps) {
  const inputKeys = useMemo(() => Object.keys(spec.inputs ?? {}), [spec.inputs]);
  const [fields, setFields] = useState<Field[]>(() =>
    inputKeys.map((key) => {
      const inp = spec.inputs![key]!;
      return {
        key,
        spec: inp,
        type: workflowInputType(inp),
        value: defaultFieldValue(inp),
      };
    }),
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const innerWidth = Math.max(30, width - 6);

  const handleSubmit = useCallback(() => {
    const params: Record<string, string> = {};
    for (const f of fields) {
      if (f.value.length > 0) params[f.key] = f.value;
    }
    const resolved = resolveInputs(spec, params);
    if (resolved.errors.length > 0) {
      setError(resolved.errors.join("; "));
      return;
    }
    onSubmit(resolved.values);
  }, [fields, spec, onSubmit]);

  const updateFocused = useCallback(
    (value: string, nextSuggestions?: string[]) => {
      setFields((prev) => {
        const next = [...prev];
        const field = next[focusIndex];
        if (!field) return prev;
        next[focusIndex] = { ...field, value };
        return next;
      });
      setSuggestions(nextSuggestions ?? []);
      setError(null);
    },
    [focusIndex],
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        if (editing) {
          setEditing(false);
          setSuggestions([]);
          return;
        }
        onCancel();
        return;
      }

      const field = fields[focusIndex];
      if (!field) return;

      const choices = choicesForField(field, modelSuggestions, agentSuggestions);
      const hasExplicitChoices = Boolean(field.spec.choices && field.spec.choices.length > 0);
      const isChoiceField =
        field.type === "boolean" ||
        field.type === "enum" ||
        hasExplicitChoices ||
        (field.type === "agent" && choices.length > 0);

      if (editing && field.type === "boolean") {
        if (input === "y" || input === "1") {
          updateFocused("true");
          setEditing(false);
        } else if (input === "n" || input === "0") {
          updateFocused("false");
          setEditing(false);
        } else if (key.backspace || key.delete) {
          updateFocused("");
          setEditing(false);
        } else if (key.return && field.value) {
          setEditing(false);
          handleSubmit();
        }
        return;
      }

      if (key.tab && !key.shift) {
        // Tab completes model/agent free-text; otherwise advances field.
        if (!editing && (field.type === "model" || field.type === "agent") && !hasExplicitChoices) {
          const pool = field.type === "model" ? modelSuggestions : agentSuggestions;
          const matches = filterSuggestions(pool, field.value);
          if (matches.length === 1 && matches[0] !== field.value) {
            updateFocused(matches[0]!, []);
            return;
          }
          if (matches.length > 1) {
            const prefix = longestCommonPrefix(matches);
            if (prefix.length > field.value.length) {
              updateFocused(prefix, matches.slice(0, 8));
              return;
            }
            // Already at the shared prefix: first Tab shows suggestions,
            // second Tab advances to the next field.
            if (suggestions.length === 0) {
              setSuggestions(matches.slice(0, 8));
              return;
            }
          }
        }
        setFocusIndex((i) => (i + 1) % fields.length);
        setEditing(false);
        setSuggestions([]);
        setError(null);
        return;
      }
      if (key.tab && key.shift) {
        setFocusIndex((i) => (i - 1 + fields.length) % fields.length);
        setEditing(false);
        setSuggestions([]);
        setError(null);
        return;
      }

      // Arrow cycle for enum / constrained pickers
      if ((key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) && isChoiceField) {
        const direction: 1 | -1 = key.leftArrow || key.upArrow ? -1 : 1;
        updateFocused(cycleValue(choices, field.value, direction));
        return;
      }

      if (key.return) {
        if (field.type === "boolean") {
          // Empty → enter y/n edit; already set → submit the form.
          if (!field.value) {
            setEditing(true);
            return;
          }
          handleSubmit();
          return;
        }
        if (isChoiceField && !field.value && choices.length > 0) {
          updateFocused(choices[0]!);
          return;
        }
        handleSubmit();
        return;
      }

      if (isChoiceField) {
        // Constrained pickers: typing a digit picks 1-based index.
        if (/^[1-9]$/.test(input)) {
          const idx = Number(input) - 1;
          if (choices[idx] !== undefined) updateFocused(choices[idx]!);
          return;
        }
        return;
      }

      // Free-text / model / number typing
      if (key.backspace || key.delete) {
        const nextVal = field.value.slice(0, -1);
        const pool =
          field.type === "model"
            ? modelSuggestions
            : field.type === "agent"
              ? agentSuggestions
              : [];
        updateFocused(nextVal, pool.length ? filterSuggestions(pool, nextVal).slice(0, 8) : []);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (field.type === "number" && !/[\d.\-eE+]/.test(input)) return;
        const nextVal = field.value + input;
        const pool =
          field.type === "model"
            ? modelSuggestions
            : field.type === "agent"
              ? agentSuggestions
              : [];
        updateFocused(nextVal, pool.length ? filterSuggestions(pool, nextVal).slice(0, 8) : []);
      }
    },
    { isActive: true },
  );

  const maxLabelLen = inputKeys.reduce((max, k) => Math.max(max, k.length), 0);
  const focused = fields[focusIndex];
  const focusedChoices = focused
    ? choicesForField(focused, modelSuggestions, agentSuggestions)
    : [];
  const fallbackHint =
    focused?.type === "model" &&
    focused.spec.fallbackModels &&
    focused.spec.fallbackModels.length > 0
      ? `fallback: ${focused.spec.fallbackModels.join(" → ")}`
      : "";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      height={height}
      width={Math.max(40, width)}
    >
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          input parameters · {spec.name}
        </Text>
        <Text color="gray">
          {editing
            ? "y/n toggle · Backspace clear · Esc cancel"
            : focused?.type === "enum" || (focused?.spec.choices && focused.spec.choices.length > 0)
              ? "←→ cycle · 1-9 pick · Enter submit · Esc cancel"
              : focused?.type === "model" || focused?.type === "agent"
                ? "Tab complete · Enter submit · Esc cancel"
                : focused?.type === "boolean"
                  ? "Enter edit empty / submit set · Esc cancel"
                  : "Tab field · Enter edit/submit · Esc cancel"}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {fields.map((field, i) => {
          const isFocused = i === focusIndex;
          const label = field.key.padEnd(maxLabelLen);
          const required =
            field.spec.required === true ||
            (field.spec.required !== false && field.spec.default === undefined);
          const desc = field.spec.description;
          const defaultHint =
            field.spec.default !== undefined ? `default: ${String(field.spec.default)}` : "";
          const hint = typeHint(field.type);
          const fieldChoices = choicesForField(field, modelSuggestions, agentSuggestions);
          const fieldHasChoices = Boolean(field.spec.choices && field.spec.choices.length > 0);

          return (
            <Box key={field.key} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={isFocused ? "cyan" : "white"} bold={isFocused}>
                  {isFocused ? "▶ " : "  "}
                  {label}
                  {required ? <Text color="red"> *</Text> : null}
                  {hint ? <Text color="gray"> {hint}</Text> : null}
                </Text>
              </Box>
              {desc ? (
                <Box paddingLeft={maxLabelLen + 4} width={innerWidth}>
                  <Text color="gray" wrap="truncate-end">
                    {desc}
                  </Text>
                </Box>
              ) : null}
              <Box paddingLeft={maxLabelLen + 4}>
                {field.type === "boolean" ? (
                  <Text color={isFocused ? "cyan" : "white"}>
                    {editing && isFocused ? (
                      `[${field.value || "?"}] y/n`
                    ) : field.value ? (
                      `[${field.value}]`
                    ) : defaultHint ? (
                      <Text color="gray">{defaultHint}</Text>
                    ) : (
                      <Text color="gray">(not set)</Text>
                    )}
                  </Text>
                ) : field.type === "enum" ||
                  fieldHasChoices ||
                  (field.type === "agent" && field.spec.choices?.length) ? (
                  <Text color={isFocused ? "cyan" : "white"}>
                    {field.value ? (
                      `[${field.value}]`
                    ) : defaultHint ? (
                      <Text color="gray">{defaultHint}</Text>
                    ) : (
                      <Text color="gray">(not set)</Text>
                    )}
                    {isFocused && fieldChoices.length > 0 ? (
                      <Text color="gray">
                        {" "}
                        · {fieldChoices.map((c, idx) => `${idx + 1}:${c}`).join(" ")}
                      </Text>
                    ) : null}
                  </Text>
                ) : (
                  <Text color={isFocused ? "cyan" : "white"}>
                    {field.value ? (
                      field.value + (isFocused ? "▋" : "")
                    ) : isFocused ? (
                      "▋"
                    ) : defaultHint ? (
                      <Text color="gray">{defaultHint}</Text>
                    ) : (
                      <Text color="gray">(not set)</Text>
                    )}
                  </Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      {fallbackHint ? (
        <Box marginBottom={1} width={innerWidth}>
          <Text color="gray" wrap="truncate-end">
            {fallbackHint}
          </Text>
        </Box>
      ) : null}

      {suggestions.length > 0 ? (
        <Box marginBottom={1} width={innerWidth}>
          <Text color="cyan" wrap="truncate-end">
            suggestions: {suggestions.join(" · ")}
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}

      <Box>
        <Text color="gray">
          {fields.length} parameter{fields.length === 1 ? "" : "s"} · Enter to submit
          {focusedChoices.length > 0 && focused?.type === "enum"
            ? ` · ${focusedChoices.length} choices`
            : ""}
        </Text>
      </Box>
    </Box>
  );
}
