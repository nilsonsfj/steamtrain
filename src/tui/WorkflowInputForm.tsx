import { Box, Text, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";
import type { WorkflowInputSpec, WorkflowSpec } from "../workflow";
import { resolveInputs } from "../workflow";

interface Field {
  key: string;
  spec: WorkflowInputSpec;
  type: "string" | "number" | "boolean";
  value: string;
}

interface WorkflowInputFormProps {
  spec: WorkflowSpec;
  width: number;
  height: number;
  onSubmit: (params: Record<string, string | number | boolean>) => void;
  onCancel: () => void;
}

const BOOLEAN_OPTIONS = [
  { value: "true", label: "yes" },
  { value: "false", label: "no" },
];

function defaultFieldValue(spec: WorkflowInputSpec): string {
  if (spec.default !== undefined) return String(spec.default);
  return "";
}

export function WorkflowInputForm({
  spec,
  width,
  height,
  onSubmit,
  onCancel,
}: WorkflowInputFormProps) {
  const inputKeys = useMemo(() => Object.keys(spec.inputs ?? {}), [spec.inputs]);
  const [fields, setFields] = useState<Field[]>(() =>
    inputKeys.map((key) => {
      const inp = spec.inputs![key]!;
      return {
        key,
        spec: inp,
        type: inp.type ?? "string",
        value: defaultFieldValue(inp),
      };
    }),
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useInput(
    (input, key) => {
      if (key.escape) {
        if (editing) {
          setEditing(false);
          return;
        }
        onCancel();
        return;
      }

      if (editing) {
        // In editing mode for boolean fields — y/n selects, Backspace/Delete clears
        const field = fields[focusIndex];
        if (field?.type === "boolean") {
          if (input === "y" || input === "1") {
            const next = [...fields];
            next[focusIndex] = { ...field, value: "true" };
            setFields(next);
            setEditing(false);
            setError(null);
          } else if (input === "n" || input === "0") {
            const next = [...fields];
            next[focusIndex] = { ...field, value: "false" };
            setFields(next);
            setEditing(false);
            setError(null);
          } else if (key.backspace || key.delete) {
            const next = [...fields];
            next[focusIndex] = { ...field, value: "" };
            setFields(next);
            setEditing(false);
            setError(null);
          }
        }
        return;
      }

      if (key.tab && !key.shift) {
        setFocusIndex((i) => (i + 1) % fields.length);
        setError(null);
        return;
      }
      if (key.tab && key.shift) {
        setFocusIndex((i) => (i - 1 + fields.length) % fields.length);
        setError(null);
        return;
      }

      if (key.return) {
        const field = fields[focusIndex];
        if (field?.type === "boolean") {
          setEditing(true);
          return;
        }
        // For string/number, Enter submits the form
        handleSubmit();
        return;
      }

      // Type into the current field (string/number only)
      const field = fields[focusIndex];
      if (!field || field.type === "boolean") return;

      const next = [...fields];
      if (key.backspace || key.delete) {
        next[focusIndex] = { ...field, value: field.value.slice(0, -1) };
        setFields(next);
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        // Permissive keystroke guard for number fields — rejects obviously
        // non-numeric characters but doesn't validate the full value (that
        // happens at submit time via resolveInputs).
        if (field.type === "number" && !/[\d.\-eE+]/.test(input)) return;
        next[focusIndex] = { ...field, value: field.value + input };
        setFields(next);
        setError(null);
      }
    },
    { isActive: true },
  );

  const maxLabelLen = inputKeys.reduce((max, k) => Math.max(max, k.length), 0);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          input parameters · {spec.name}
        </Text>
        <Text color="gray">
          {editing
            ? "y/n toggle · Backspace clear · Esc cancel"
            : "Tab field · Enter edit/submit · Esc cancel"}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {fields.map((field, i) => {
          const focused = i === focusIndex;
          const label = field.key.padEnd(maxLabelLen);
          const required =
            field.spec.required === true ||
            (field.spec.required !== false && field.spec.default === undefined);
          const desc = field.spec.description;
          const defaultHint =
            field.spec.default !== undefined ? `default: ${String(field.spec.default)}` : "";
          const typeLabel =
            field.type === "boolean" ? "(y/n)" : field.type === "number" ? "(number)" : "";

          return (
            <Box key={field.key} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={focused ? "cyan" : "white"} bold={focused}>
                  {focused ? "▶ " : "  "}
                  {label}
                  {required ? <Text color="red"> *</Text> : null}
                  {typeLabel ? <Text color="gray"> {typeLabel}</Text> : null}
                </Text>
              </Box>
              {desc ? (
                <Box paddingLeft={maxLabelLen + 4}>
                  <Text color="gray" wrap="truncate-end">
                    {desc}
                  </Text>
                </Box>
              ) : null}
              <Box paddingLeft={maxLabelLen + 4}>
                {field.type === "boolean" ? (
                  <Text color={focused ? "cyan" : "white"}>
                    {editing ? (
                      `[${focused ? "…" : field.value || "?"}] y/n`
                    ) : field.value ? (
                      `[${field.value}]`
                    ) : defaultHint ? (
                      <Text color="gray">{defaultHint}</Text>
                    ) : (
                      <Text color="gray">(not set)</Text>
                    )}
                  </Text>
                ) : (
                  <Text color={focused ? "cyan" : "white"}>
                    {field.value ? (
                      field.value + (focused ? "▋" : "")
                    ) : focused ? (
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

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}

      <Box>
        <Text color="gray">
          {fields.length} parameter{fields.length === 1 ? "" : "s"} · Enter to submit
        </Text>
      </Box>
    </Box>
  );
}
