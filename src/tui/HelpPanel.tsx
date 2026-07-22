import { Box, Text } from "ink";
import type React from "react";
import { listSlashCommands } from "../commands";

/**
 * The `/help` overlay: core keybindings plus every registered slash command.
 * Rendered in place of the picker/stream (like the history browser); the
 * keyboard hook closes it on Esc/Enter/q.
 */

interface KeyHint {
  keys: string;
  action: string;
}

const KEY_HINTS: readonly KeyHint[] = [
  { keys: "Enter", action: "run the selected workflow · open step details during a run" },
  { keys: "↑/↓", action: "pick a workflow · inspect steps · browse prompt history" },
  { keys: "Tab", action: "switch mode (in a preview: toggle the step detail panel)" },
  { keys: "Ctrl+R", action: "run fresh, ignoring the on-disk cache" },
  { keys: "Ctrl+D", action: "dry-run: preview the resolved plan without running" },
  {
    keys: "Ctrl+E",
    action: "edit the selected preview step (agent/model/effort/prompt; A = apply to all)",
  },
  { keys: "Ctrl+N", action: "create a new workflow from a description" },
  { keys: "Ctrl+J", action: "open runs browser (also /history · / filter · t status)" },
  { keys: "Ctrl+A", action: "open the agent manager (also /agents; /apis for APIs)" },
  {
    keys: "p",
    action: "pause/resume the live run · e edits a pending step (prompt/model/effort) while paused",
  },
  { keys: "a / r", action: "approve / reject a pending human checkpoint" },
  { keys: "a", action: "answer a pending human-input request (human step / agent question)" },
  {
    keys: "d",
    action: "detach the live run into a background process (keeps running if you close the TUI)",
  },
  {
    keys: "PgUp/PgDn",
    action: "page the step list · scroll output in drill-in (Shift+↑/↓ one line)",
  },
  {
    keys: "Esc",
    action: "back / cancel · Ctrl+Q cancels after confirm (or detaches an attached run)",
  },
  { keys: "Ctrl+C", action: "quit · confirm again while a non-detached run is active" },
];

export function HelpPanel({ width, height }: { width: number; height: number }): React.ReactNode {
  const commands = listSlashCommands();
  const keysWidth = Math.max(...KEY_HINTS.map((hint) => hint.keys.length));
  // The registry is mutable; guard the spread so an empty one can't produce
  // -Infinity pad widths.
  const nameWidth = commands.length > 0 ? Math.max(...commands.map((c) => c.name.length)) + 1 : 1;

  const rows: React.ReactNode[] = [
    <Text key="keys-header" color="gray" bold>
      keys
    </Text>,
    ...KEY_HINTS.map((hint) => (
      <Text key={`key-${hint.keys}`} wrap="truncate-end">
        {"  "}
        <Text color="cyan">{hint.keys.padEnd(keysWidth)}</Text>
        {"  "}
        <Text color="white">{hint.action}</Text>
      </Text>
    )),
    <Text key="spacer"> </Text>,
    <Text key="commands-header" color="gray" bold>
      commands (type / then Tab to complete · /help &lt;command&gt; for usage)
    </Text>,
    ...commands.map((command) => (
      <Text key={`cmd-${command.name}`} wrap="truncate-end">
        {"  "}
        <Text color="cyan">{`/${command.name}`.padEnd(nameWidth + 1)}</Text>
        {"  "}
        <Text color="white">{command.description}</Text>
      </Text>
    )),
  ];

  // Fit the panel: header row + border rows consume 3 lines; when the terminal
  // is short, clip the tail and say so rather than overflowing the viewport.
  const capacity = Math.max(4, height - 3);
  const clipped = rows.length > capacity;
  const visible = clipped ? rows.slice(0, capacity - 1) : rows;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      height={height}
      width={width}
    >
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          help
        </Text>
        <Text color="gray">Esc close</Text>
      </Box>
      {visible}
      {clipped ? (
        <Text color="gray">…terminal is short — {rows.length - visible.length} lines hidden</Text>
      ) : null}
    </Box>
  );
}
