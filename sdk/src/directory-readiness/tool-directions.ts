/**
 * Sentences in tool and parameter descriptions that direct a model to call,
 * or to order its calls of, ANOTHER tool in the same listing.
 *
 * Naming another tool is not the problem: "returns the same fields as
 * get_order" states a fact. A candidate is a sentence where an imperative or
 * a must/should puts the other tool in the object of a call, a hand-off, or
 * an order of calls. Telling an instruction from a fact is a judgement, so
 * these are candidates for a person or the decision scan, never a verdict.
 *
 * Publisher-neutral. Pure: reads tool text, dials nothing.
 */

import { asSchema } from "./tool-shape.js";

/** The fields of a tool the scan reads. Shape-compatible across publishers. */
export interface ToolTextEvidence {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolDirectionCandidate {
  tool: string;
  /** `description`, or a parameter's, e.g. `inputSchema.properties.id.description`. */
  field: string;
  /** The sentence, exactly as it appears in that field. */
  quote: string;
  /** The other tools the sentence names. */
  references: string[];
}

/** Characters of one field read; anything longer is not a description. */
const MAX_FIELD_CHARS = 20_000;
const MAX_QUOTE_CHARS = 400;
const MAX_SCHEMA_DEPTH = 4;

/** A run of the characters tool names use. */
const TOKEN = /[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?/g;
/**
 * A name that reads as an identifier. A plain word such as `search` counts
 * only quoted or followed by "tool": as bare text it is the English verb.
 */
const IDENTIFIER = /[_.\d-]|[a-z][A-Z]/;
const SENTENCE_END = /[.!?]+(?=\s)|\n/g;
/** Abbreviations that never end a sentence ("etc." often does). */
const ABBREVIATION = /\b(?:e\.g|i\.e|vs|cf|incl)\.$/i;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;

// The vocabulary of a direction. A sentence is a candidate when one of the
// shapes below binds a referenced tool; the verb lists stay short because a
// longer list mostly adds a tool describing its own work.
const CALL = String.raw`(?:call|invoke|run|use|execute|trigger|poll|retry|re-?run|chain|pair|combine)`;
const GERUND = String.raw`(?:calling|using|running|invoking|executing|polling)`;
const HAND = String.raw`(?:get|obtain|fetch|retrieve|look\s+up|find|read|take|copy|resolve|discover|check|verify|confirm|inspect|track|monitor|pass|provide|supply|send|feed|forward|hand|give|submit|${CALL})`;
/** Where an imperative can begin: a sentence, a clause, or a sequencing word. */
const START = String.raw`(?:^|[,;:(\u2013\u2014]\s*|\s-\s+|\b(?:and|or|then|so|to|first|next|finally|afterwards|always|also|instead|otherwise|please|only|now|immediately)\s+)`;
const MODAL = String.raw`\b(?:must|should|shall|can|may|need\s+to|needs\s+to|have\s+to|has\s+to|be\s+sure\s+to|make\s+sure\s+to|remember\s+to|(?:do\s+not|don't)\s+forget\s+to|want\s+to)\s+(?:not\s+|also\s+|first\s+|always\s+|then\s+|still\s+)?`;
/** Function words only: "use it together with", never "use the same filters as". */
const FILLER = String.raw`(?:(?:the|a|an|this|that|it|its|tool|tools|first|also|again|only|then|always|now|before|after|with|together|alongside|along|instead|of|to|right|immediately|once|back)\s+){0,4}`;
const GAP = String.raw`[^.;:!?,]{0,30}?`;
const FLOW = String.raw`(?:from|with|using|via|through|to|into|by\s+calling|by\s+running|returned\s+by|produced\s+by|output\s+(?:of|from)|result\s+of|response\s+(?:of|from))`;
const ORDER = String.raw`(?:before|after|once|until|prior\s+to|together\s+with|alongside|instead\s+of|in\s+place\s+of|rather\s+than)`;

/** Each shape, given the alternation of the tools a sentence names. */
const DIRECTIONS: ReadonlyArray<(tool: string) => string> = [
  // "Call get_item", "then use the list_orders tool", "Poll job_status"
  (tool) => `${START}${CALL}\\s+${FILLER}${tool}`,
  // "you should call list_projects first"
  (tool) => `${MODAL}${CALL}\\s+${FILLER}${tool}`,
  // "Do not call delete_item unless…", "you should never use this before
  // sync_index", but not "reads never trigger the job other_tool runs"
  (tool) =>
    `(?:${START}|${MODAL}|\\byou\\s+)(?:do\\s+not|don't|never|avoid)\\s+(?:${CALL}|${GERUND})\\b[^.;:!?]{0,60}?${tool}`,
  (tool) => `\\bkeep\\s+(?:${GERUND}|checking)\\s+(?:the\\s+)?${tool}`,
  // "Get the id from list_orders", "pass the cursor to list_more"
  (tool) =>
    `(?:${START}|${MODAL})${HAND}\\s+${GAP}\\b${FLOW}\\s+(?:the\\s+)?${tool}`,
  // "Call this only after run_tests reports success"
  (tool) =>
    `${START}${CALL}\\b[^.;:!?]{0,40}?\\b${ORDER}\\s+(?:${GERUND}\\s+)?(?:the\\s+)?${tool}`,
  // "follow up with get_details", "followed by commit_changes"
  (tool) =>
    `\\b(?:follow(?:ed)?|preceded)\\s+(?:it\\s+|this\\s+|that\\s+)?(?:up\\s+)?(?:by|with)\\s+(?:a\\s+call\\s+to\\s+|calling\\s+)?(?:the\\s+)?${tool}`,
  // "list_projects must be called first"
  (tool) =>
    `${tool}\\s+(?:must|should|needs\\s+to|has\\s+to|have\\s+to)\\s+(?:always\\s+|first\\s+)?(?:be\\s+)?(?:called|invoked|run|used|executed)\\b`,
  // "should only be called after create_session"
  (tool) =>
    `\\b(?:must|should|needs\\s+to|has\\s+to|is\\s+meant\\s+to|is\\s+intended\\s+to|are\\s+meant\\s+to)\\s+(?:only\\s+)?be\\s+(?:called|invoked|run|used|executed|paired|combined|chained)\\s+(?:only\\s+)?(?:${ORDER}|with|following|by)\\s+(?:${GERUND}\\s+)?(?:the\\s+)?${tool}`,
  // "requires calling start_session first"
  (tool) =>
    `\\brequires?\\s+(?:a\\s+)?(?:prior\\s+|previous\\s+|first\\s+)?(?:call(?:ing)?\\s+(?:to\\s+)?|running\\s+|using\\s+|invoking\\s+)(?:the\\s+)?${tool}`,
  (tool) =>
    `\\bprefer\\s+(?:${GERUND}\\s+)?(?:the\\s+)?${tool}|${tool}\\s+(?:is|are)\\s+(?:preferred|recommended)\\b`,
];

/** "Before calling delete_item, …" directs only when the sentence instructs. */
const ORDERED_CALL = (tool: string) =>
  `\\b(?:before|after|prior\\s+to|without|until|instead\\s+of|rather\\s+than)\\s+${GERUND}\\s+(?:the\\s+)?${tool}`;
const INSTRUCTION = new RegExp(
  `${START}(?:${HAND}|confirm|ask|wait|stop|ensure|tell|show|list|try|avoid|save|create|delete|update|refresh|compare)\\b|${MODAL}\\w`,
  "i"
);

export function findToolDirectionCandidates(
  tools: readonly ToolTextEvidence[]
): ToolDirectionCandidate[] {
  const names = new Set(tools.map((tool) => tool.name));
  const candidates: ToolDirectionCandidate[] = [];
  for (const tool of tools) {
    for (const [field, text] of textFields(tool)) {
      for (const sentence of sentences(text.slice(0, MAX_FIELD_CHARS))) {
        const references = referencesIn(sentence, names, tool.name);
        if (references.length === 0) continue;
        const quote = directionQuote(sentence, references);
        if (quote) {
          candidates.push({ tool: tool.name, field, quote, references });
        }
      }
    }
  }
  return candidates;
}

function textFields(tool: ToolTextEvidence): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  if (typeof tool.description === "string") {
    fields.push(["description", tool.description]);
  }
  schemaFields(tool.inputSchema, "inputSchema", 0, fields);
  return fields;
}

function schemaFields(
  value: unknown,
  path: string,
  depth: number,
  out: Array<[string, string]>
): void {
  const schema = asSchema(value);
  if (!schema || depth > MAX_SCHEMA_DEPTH) return;
  const children: Array<[string, unknown]> = [
    ...Object.entries(asSchema(schema.properties) ?? {}).map(
      ([name, child]): [string, unknown] => [
        `${path}.properties.${name}`,
        child,
      ]
    ),
    ...(schema.items === undefined
      ? []
      : [[`${path}.items`, schema.items] as [string, unknown]]),
  ];
  for (const [at, child] of children) {
    const description = asSchema(child)?.description;
    if (typeof description === "string") {
      out.push([`${at}.description`, description]);
    }
    schemaFields(child, at, depth + 1, out);
  }
}

/** The text's sentences, trimmed and without a leading list marker. */
function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const end of text.matchAll(SENTENCE_END)) {
    const stop = end.index + end[0].length;
    if (end[0] !== "\n" && ABBREVIATION.test(text.slice(start, stop))) {
      continue;
    }
    out.push(text.slice(start, stop));
    start = stop;
  }
  out.push(text.slice(start));
  return out
    .map((sentence) => sentence.trim().replace(LIST_MARKER, ""))
    .filter((sentence) => sentence.length > 0);
}

/** Other tools the sentence names, in order of first mention. */
function referencesIn(
  sentence: string,
  names: ReadonlySet<string>,
  self: string
): string[] {
  const found = new Set<string>();
  for (const token of sentence.matchAll(TOKEN)) {
    const name = token[0];
    if (name === self || found.has(name) || !names.has(name)) continue;
    const before = sentence[token.index - 1] ?? "";
    const after = sentence.slice(token.index + name.length);
    const quoted = /[`'"]/.test(before) && after.startsWith(before);
    if (IDENTIFIER.test(name) || quoted || /^\s+tools?\b/.test(after)) {
      found.add(name);
    }
  }
  return [...found];
}

function directionQuote(
  sentence: string,
  references: readonly string[]
): string | undefined {
  const tool = `(?:${references.map(nameSlot).join("|")})`;
  const patterns = [...DIRECTIONS.map((shape) => shape(tool))];
  if (INSTRUCTION.test(sentence)) patterns.push(ORDERED_CALL(tool));
  for (const pattern of patterns) {
    const match = new RegExp(pattern, "i").exec(sentence);
    if (!match) continue;
    // A long sentence is quoted from just before the direction, still verbatim.
    return sentence.length <= MAX_QUOTE_CHARS
      ? sentence
      : sentence
          .slice(Math.max(0, match.index - 100))
          .slice(0, MAX_QUOTE_CHARS)
          .trim();
  }
  return undefined;
}

function nameSlot(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return IDENTIFIER.test(name)
    ? `[\`'"]?(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)[\`'"]?`
    : `(?:\`${escaped}\`|'${escaped}'|"${escaped}"|${escaped}(?=\\s+tools?\\b))`;
}
