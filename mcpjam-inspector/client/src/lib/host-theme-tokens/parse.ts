export type ParsedTokenValue =
  | { kind: "light-dark"; light: string; dark: string; raw: string }
  | { kind: "solid"; value: string; raw: string };

/**
 * Split `light-dark(a, b)` on the top-level comma so nested
 * `rgba(...)` / `oklch(...)` arguments stay intact.
 */
export function parseTokenValue(raw: string): ParsedTokenValue {
  const trimmed = raw.trim();
  const match = /^light-dark\s*\(/i.exec(trimmed);
  if (!match || !trimmed.endsWith(")")) {
    return { kind: "solid", value: trimmed, raw };
  }
  const inner = trimmed.slice(match[0].length, -1);
  const parts = splitTopLevelComma(inner);
  if (parts.length !== 2) {
    return { kind: "solid", value: trimmed, raw };
  }
  return {
    kind: "light-dark",
    light: parts[0].trim(),
    dark: parts[1].trim(),
    raw,
  };
}

function splitTopLevelComma(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

export function extractStyleVariables(
  hostContext: Record<string, unknown> | undefined,
): Record<string, string> | null {
  if (!hostContext) return null;
  const styles = hostContext.styles;
  if (!isPlainObject(styles)) return null;
  const variables = styles.variables;
  if (!isPlainObject(variables)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COLOR_NAME = /^--color-/;
const COLOR_VALUE =
  /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|light-dark\()/i;

export function isColorToken(name: string, raw: string): boolean {
  return COLOR_NAME.test(name) || COLOR_VALUE.test(raw.trim());
}
