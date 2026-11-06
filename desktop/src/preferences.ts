import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseTheme, type Theme } from "./policy.ts";
export function loadTheme(home: string): Theme {
  try {
    return parseTheme(JSON.parse(readFileSync(join(home, "appearance.json"), "utf8")).theme);
  } catch {
    return "system";
  }
}
export function saveTheme(home: string, value: Theme): void {
  const theme = parseTheme(value);
  const target = join(home, "appearance.json");
  writeFileSync(`${target}.tmp`, JSON.stringify({ theme }) + "\n", { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}
