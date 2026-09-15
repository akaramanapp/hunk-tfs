import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory that contains this extension's package.json / index.ts. */
export const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse one dotenv body into key/value pairs.
 * Supports optional export prefix, single/double quotes, and # comments.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }

    out[key] = value;
  }
  return out;
}

/**
 * Apply .env values into `env` without overriding keys that are already set
 * to a non-empty string (shell exports win).
 */
export function applyDotEnvFile(env: NodeJS.ProcessEnv, path: string): boolean {
  if (!existsSync(path)) return false;
  const parsed = parseDotEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    const current = env[key];
    if (current !== undefined && current !== "") continue;
    env[key] = value;
  }
  return true;
}

/**
 * Load extension-local `.env`, then cwd `.env`.
 * Existing non-empty process/shell values are never overwritten.
 */
export function loadTfsDotEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  extensionRoot: string = EXTENSION_ROOT,
): string[] {
  const loaded: string[] = [];
  for (const path of [join(extensionRoot, ".env"), join(cwd, ".env")]) {
    if (applyDotEnvFile(env, path)) loaded.push(path);
  }
  return loaded;
}
