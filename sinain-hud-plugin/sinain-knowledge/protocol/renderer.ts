/**
 * sinain-knowledge — Protocol Renderer
 *
 * Reads base protocol templates (heartbeat.md, skill.md) and binding files,
 * then replaces {{KEY}} placeholders with binding values.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ProtocolName = "heartbeat" | "skill";
export type BindingName = "openclaw" | "generic";

/**
 * Parse a binding file (KEY=VALUE lines, ignoring comments and blanks).
 */
function parseBinding(content: string): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    bindings[key] = value;
  }
  return bindings;
}

/**
 * Render a protocol template with a specific binding.
 *
 * @param protocol - "heartbeat" or "skill"
 * @param binding - "openclaw" or "generic"
 * @returns The rendered markdown string
 */
export function render(protocol: ProtocolName, binding: BindingName): string {
  const templatePath = join(__dirname, `${protocol}.md`);
  const bindingPath = join(__dirname, "bindings", `${binding}.md`);

  const template = readFileSync(templatePath, "utf-8");
  const bindingContent = readFileSync(bindingPath, "utf-8");
  const bindings = parseBinding(bindingContent);

  let result = template;
  for (const [key, value] of Object.entries(bindings)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    result = result.replace(pattern, value);
  }

  return result;
}
