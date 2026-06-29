import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { safeJson, truncate } from "../agents/util";
import { AGENT_COLOR, EVENT_STYLE } from "./theme";
import type { DisplayItem } from "./transcript";

interface EventRowProps {
  item: DisplayItem;
  width: number;
}

/** Render one transcript item with a glyph + color appropriate to its kind. */
export function EventRow({ item, width }: EventRowProps) {
  const textWidth = Math.max(16, width - 4);

  switch (item.kind) {
    case "session_start": {
      const s = EVENT_STYLE.session_start;
      const bits = [
        item.sessionId ? `session ${item.sessionId}` : "session started",
        item.model ? truncate(item.model, 30) : undefined,
        item.toolCount !== undefined ? `${item.toolCount} tools` : undefined,
      ].filter(Boolean);
      return (
        <Line symbol={s.symbol} color={s.color} dim>
          {bits.join("  ·  ")}
        </Line>
      );
    }

    case "text": {
      const style = item.thinking ? EVENT_STYLE.thinking : EVENT_STYLE.text;
      return (
        <Box flexDirection="row">
          {item.thinking ? <Text color={style.color}>{style.symbol} </Text> : null}
          <Box width={textWidth}>
            <Text color={item.thinking ? "gray" : undefined} italic={item.thinking} wrap="wrap">
              {item.text}
            </Text>
          </Box>
        </Box>
      );
    }

    case "tool_use": {
      const s = EVENT_STYLE.tool_use;
      const args = summarizeInput(item.input);
      return (
        <Line symbol={s.symbol} color={s.color}>
          <Text color={s.color} bold>
            {item.name}
          </Text>
          {args ? (
            <Text color="gray"> {truncate(args, textWidth - item.name.length - 4)}</Text>
          ) : null}
        </Line>
      );
    }

    case "tool_result": {
      const s = item.isError ? EVENT_STYLE.tool_result_err : EVENT_STYLE.tool_result_ok;
      const out = (item.output ?? "").replace(/\s+/g, " ").trim();
      return (
        <Line symbol={s.symbol} color={s.color}>
          {item.name ? <Text color={s.color}>{item.name} </Text> : null}
          <Text color="gray">{truncate(out || "(no output)", textWidth - 6)}</Text>
        </Line>
      );
    }

    case "result": {
      const s = item.isError ? EVENT_STYLE.result_err : EVENT_STYLE.result_ok;
      const meta = [
        item.subtype && item.subtype !== "success" ? item.subtype : undefined,
        item.durationMs !== undefined ? `${(item.durationMs / 1000).toFixed(1)}s` : undefined,
        item.costUsd ? `$${item.costUsd.toFixed(4)}` : undefined,
      ].filter(Boolean);
      return (
        <Box flexDirection="column">
          <Line symbol={s.symbol} color={s.color}>
            <Text color={s.color} bold>
              {item.isError ? "result (error)" : "result"}
            </Text>
            {meta.length > 0 ? <Text color="gray"> {meta.join("  ·  ")}</Text> : null}
          </Line>
          {item.text ? (
            <Box paddingLeft={2} width={textWidth}>
              <Text color={item.isError ? "red" : undefined} wrap="wrap">
                {truncate(item.text, 600)}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }

    case "error": {
      const s = EVENT_STYLE.error;
      return (
        <Line symbol={s.symbol} color={s.color}>
          <Text color={s.color}>{truncate(item.message, textWidth - 4)}</Text>
        </Line>
      );
    }

    case "notice": {
      const s =
        item.level === "error"
          ? EVENT_STYLE.notice_error
          : item.level === "warn"
            ? EVENT_STYLE.notice_warn
            : EVENT_STYLE.notice_info;
      return (
        <Line symbol={s.symbol} color={s.color}>
          <Text color={s.color}>{item.text}</Text>
        </Line>
      );
    }

    case "unknown": {
      const s = EVENT_STYLE.unknown;
      return (
        <Line symbol={s.symbol} color={s.color} dim>
          {`unknown${item.rawType ? ` (${item.rawType})` : ""}`}
        </Line>
      );
    }
  }
}

function Line({
  symbol,
  color,
  dim,
  children,
}: {
  symbol: string;
  color: string;
  dim?: boolean;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="row">
      {symbol ? (
        <Text color={color} dimColor={dim}>
          {symbol}{" "}
        </Text>
      ) : null}
      <Text dimColor={dim}>{children}</Text>
    </Box>
  );
}

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object" && !Array.isArray(input)) {
    // Surface the most useful single field if present.
    for (const key of ["command", "file_path", "path", "pattern", "query", "description"]) {
      const v = (input as Record<string, unknown>)[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return safeJson(input);
  }
  return String(input);
}
