import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text } from "ink";

/**
 * The banner art lives in `banner.txt` (the editable source of truth). We read
 * it at runtime when running from source; when bundled (`dist/`), the .txt is
 * not alongside the module, so we fall back to this embedded copy. Stored as a
 * `String.raw` constant — never inlined into JSX — to avoid whitespace
 * collapse and brace/escape surprises.
 */
const FALLBACK_BANNER = String.raw`
                    ___   ___   ___
                   (   ) (   ) (   )   . o O
              ______|_____|_____|_________
         ____|   S  T  E  A  M  T  R  A  I  N   |____
    ____|___ |   agent orchestrator on rails    | ___|____
   |___ ___ \|________________________________ |/ ___ ___|
     (O) (O)===============(O)===============(O)===(O) (O)
`;

// Per-line palette. Cyan/blue/magenta/yellow stay readable on both light and
// dark terminals; the lettered line is emphasized.
const LINE_COLORS = ["magenta", "magenta", "blue", "cyan", "blue", "blue", "yellow"] as const;
const TITLE_LINE = 3;

function loadBannerArt(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "banner.txt"), "utf8");
  } catch {
    return FALLBACK_BANNER;
  }
}

export function Banner() {
  const lines = loadBannerArt().replace(/^\n/, "").replace(/\n+$/, "").split("\n");
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: static art, stable order
          key={i}
          color={LINE_COLORS[i] ?? "cyan"}
          bold={i === TITLE_LINE}
        >
          {line.length === 0 ? " " : line}
        </Text>
      ))}
    </Box>
  );
}
