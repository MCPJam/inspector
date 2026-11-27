/**
 * The part of RFC 6570 a mock's resource templates use: literal text, simple
 * variables (`{name}`, one path segment, percent-decoded) and reserved ones
 * (`{+name}`, anything). Operators for queries, fragments and lists are not
 * read; a template that uses one is refused when the definition is saved,
 * which beats a template that lists and never matches.
 */

const VARIABLE = /\{(\+?)([A-Za-z0-9_]+)\}/g;
const ANY_BRACE = /[{}]/;

interface Compiled {
  pattern: RegExp;
  variables: string[];
}

function compile(template: string): Compiled | undefined {
  const variables: string[] = [];
  let source = "";
  let last = 0;
  for (const match of template.matchAll(VARIABLE)) {
    const literal = template.slice(last, match.index);
    if (ANY_BRACE.test(literal)) return undefined;
    source += escapeRegExp(literal);
    const reserved = match[1];
    const name = match[2] ?? "";
    if (variables.includes(name)) return undefined;
    variables.push(name);
    source += reserved ? "(.+)" : "([^/?#]+)";
    last = (match.index ?? 0) + match[0].length;
  }
  const tail = template.slice(last);
  if (ANY_BRACE.test(tail)) return undefined;
  source += escapeRegExp(tail);
  return { pattern: new RegExp(`^${source}$`), variables };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The variable names, or `undefined` when the template uses what this mock does not read. */
export function templateVariables(template: string): string[] | undefined {
  return compile(template)?.variables;
}

/** The variables a URI gives the template, or `undefined` when it does not match. */
export function matchTemplate(
  template: string,
  uri: string
): Record<string, string> | undefined {
  const compiled = compile(template);
  const found = compiled?.pattern.exec(uri);
  if (!compiled || !found) return undefined;
  const values: Record<string, string> = {};
  for (const [i, name] of compiled.variables.entries()) {
    const raw = found[i + 1] ?? "";
    try {
      values[name] = decodeURIComponent(raw);
    } catch {
      // A malformed escape is taken literally, as a lenient server would.
      values[name] = raw;
    }
  }
  return values;
}
