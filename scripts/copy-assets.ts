import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "src", "web", "public");
const dst = resolve(here, "..", "dist", "public");

if (!existsSync(src)) {
  throw new Error(`static web assets not found: ${src}`);
}

mkdirSync(dirname(dst), { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`Copied static web assets -> ${dst}`);
