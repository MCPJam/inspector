/**
 * The classification sheet: a SUGGESTED Read / Write / Sensitive-write class
 * for every tool, and the signals behind each suggestion.
 *
 * WHY A SUGGESTION AND NEVER A GRADE. Meta classifies each tool itself, from
 * the submitter's documentation (§3.2), and MCP's annotations cannot express
 * Muse's third class at all: `destructiveHint` means "may delete or
 * overwrite", and sending an email is neither, yet §3.2 names it as the
 * example of a sensitive write. So what this module produces is the table a
 * submitter starts from — §5.6 asks for exactly that table in the
 * documentation until the portal takes it directly — with the reason for
 * every row, so a wrong row is easy to see and overrule.
 *
 * WHAT THE SIGNALS ARE. Plain word lists over the tool's name and description.
 * They are deliberately conservative where a false positive is an accusation
 * (a READ tool flagged as hiding a write) and generous where it is only a
 * nudge (a WRITE tool flagged as possibly sensitive). Nothing here can fail a
 * lane: the findings built on it are `heuristic`, in experience-insights.
 *
 * Pure: reads a tool listing, dials nothing. Safe from the browser entry.
 */

import {
  asSchema,
  demonstrableReadWriteVerbs,
} from "../directory-readiness/tool-shape.js";
import type { MuseToolClass } from "./profile.js";

/** The subset of a tool definition the sheet reads. */
export interface MuseToolEvidence {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

/** Where a row's base class came from. */
export type MuseClassificationBasis =
  /** `readOnlyHint` was declared, either way. */
  | "annotation"
  /**
   * The schema enumerates both a read and a write operation, so §3.2's "a
   * tool that combines reads and writes must be classified as a write"
   * applies whatever the hint says.
   */
  | "combined-operations"
  /**
   * No `readOnlyHint`. MCP's default for an absent hint is "not read-only",
   * so the server has made no read-only claim and the row starts as a write.
   */
  | "default";

export interface MuseClassificationRow {
  tool: string;
  /** The suggested class. Never Meta's decision — see the module docblock. */
  suggested: MuseToolClass;
  basis: MuseClassificationBasis;
  /** One line per signal behind the suggestion, for a human to weigh. */
  reasons: string[];
  /** The submitter's declared class, when a profile supplied one. */
  declared?: MuseToolClass;
}

// ── Signals ─────────────────────────────────────────────────────────────

/**
 * Words that make a WRITE consequential wherever they appear in its name:
 * money, messages to other people, publication, commitments. §3.2's own
 * examples are "make a purchase, send an email", and its concealment rule
 * names "send, share, publish, or payment".
 *
 * Matched as whole name WORDS, so `email` matches `send_email` and not
 * `emailed_at`. Words that are just as often a noun in an ordinary write —
 * `book` (`add_book`), `order` (`update_sort_order`), `post` — are left to
 * {@link LEADING_ACTION_VERBS}, where their position makes them a verb.
 */
const SENSITIVE_NAME_WORDS = new Set([
  "pay",
  "payment",
  "payments",
  "purchase",
  "checkout",
  "charge",
  "refund",
  "transfer",
  "send",
  "email",
  "sms",
  "share",
  "publish",
  "tweet",
  "invite",
  "booking",
  "reservation",
  "reserve",
  "subscribe",
  "subscription",
  "donate",
]);

/**
 * Verbs that, at the START of a name, say the tool performs an action rather
 * than reads about one.
 *
 * This is the only name signal used against READ tools, where a match reads as
 * "this tool may be hiding a write" — and `get_booking` or `list_payments`
 * must never trip that. A read tool's name leads with its read verb, so only
 * the leading word counts.
 */
const LEADING_ACTION_VERBS = new Set([
  "pay",
  "purchase",
  "buy",
  "checkout",
  "charge",
  "refund",
  "transfer",
  "send",
  "email",
  "share",
  "publish",
  "post",
  "tweet",
  "invite",
  "book",
  "reserve",
  "subscribe",
  "donate",
  "tip",
  "place",
]);

/**
 * Phrases in a description that state a consequential action outright.
 *
 * Verb + object, never a bare noun: "lists your bookings" and "returns recent
 * charges" are reads, and only an explicit "sends an email" or "charges the
 * card" says the tool does the thing.
 */
const SENSITIVE_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /\bsends?\s+(?:an?\s+|the\s+|your\s+)?(?:e-?mail|message|sms|text|notification|invite|invitation|dm)\b/i,
  /\b(?:charges?|bills?)\s+(?:the\s+|your\s+|a\s+)?(?:card|customer|user|account|payment method)\b/i,
  /\bplaces?\s+(?:an?\s+|the\s+)?order\b/i,
  /\b(?:completes?|makes?|submits?)\s+(?:an?\s+|the\s+)?(?:purchase|payment|booking|reservation|order)\b/i,
  /\bpublish(?:es)?\s+(?:an?\s+|the\s+|your\s+|it\b)/i,
  /\bshares?\s+(?:it\s+|the\s+\w+\s+|this\s+\w+\s+)?(?:with|publicly)\b/i,
  /\btransfers?\s+(?:the\s+)?(?:funds|money)\b/i,
  /\b(?:books?|reserves?)\s+(?:an?\s+|the\s+)?(?:room|flight|table|seat|appointment|ticket|stay|reservation)\b/i,
];

/** §4.6: transfers between financial accounts. */
const MONEY_MOVEMENT_PATTERNS: readonly RegExp[] = [
  /\b(?:transfers?|transferring|moves?|moving|sends?|sending)\s+(?:the\s+)?(?:funds|money|cash|balance)\b/i,
  /\bwire\s+transfer\b/i,
  /\b(?:ach|p2p)\s+(?:transfer|payment)\b/i,
  /\bbetween\s+(?:your\s+)?(?:bank\s+)?accounts\b/i,
];

/** §4.6: tools that place financial trade orders. */
const TRADE_SUBJECT =
  /\b(?:stocks?|shares\s+of|equit(?:y|ies)|securit(?:y|ies)|etfs?|crypto(?:currency|currencies)?|options?\s+contracts?|brokerage)\b/i;
const TRADE_NAME_WORDS = new Set(["trade", "buy", "sell", "order"]);
const TRADE_PARAMETER_NAMES = new Set(["symbol", "ticker"]);

/** Split a tool name into lowercase words across snake, kebab and camel case. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function hints(tool: MuseToolEvidence): {
  readOnly?: boolean;
  destructive?: boolean;
} {
  const annotations = tool.annotations ?? {};
  return {
    readOnly:
      typeof annotations.readOnlyHint === "boolean"
        ? annotations.readOnlyHint
        : undefined,
    destructive:
      typeof annotations.destructiveHint === "boolean"
        ? annotations.destructiveHint
        : undefined,
  };
}

function descriptionOf(tool: MuseToolEvidence): string {
  return [tool.title, tool.description].filter(Boolean).join(" \n ");
}

/** Signals that a WRITE tool may be sensitive. Empty when there are none. */
export function sensitiveWriteSignals(tool: MuseToolEvidence): string[] {
  const signals: string[] = [];
  const all = nameWords(tool.name);
  const words = [
    ...new Set(
      all.filter(
        (word, index) =>
          SENSITIVE_NAME_WORDS.has(word) ||
          (index === 0 && LEADING_ACTION_VERBS.has(word))
      )
    ),
  ];
  if (words.length > 0) {
    signals.push(`name contains ${words.map((w) => `"${w}"`).join(", ")}`);
  }
  const description = descriptionOf(tool);
  for (const pattern of SENSITIVE_DESCRIPTION_PATTERNS) {
    const match = pattern.exec(description);
    if (match) signals.push(`description says "${match[0].trim()}"`);
  }
  if (hints(tool).destructive === true) {
    signals.push("declares destructiveHint: true (an irreversible change)");
  }
  return signals;
}

/**
 * Signals that a tool presented as a READ performs a consequential action —
 * §3.2's "never hide a send, share, publish, or payment action in a tool
 * described as a read". Conservative: only a leading action verb in the name
 * or an explicit action phrase in the description counts.
 */
export function concealedWriteSignals(tool: MuseToolEvidence): string[] {
  const signals: string[] = [];
  const first = nameWords(tool.name)[0];
  if (first && LEADING_ACTION_VERBS.has(first)) {
    signals.push(`name starts with the action verb "${first}"`);
  }
  const description = descriptionOf(tool);
  for (const pattern of SENSITIVE_DESCRIPTION_PATTERNS) {
    const match = pattern.exec(description);
    if (match) signals.push(`description says "${match[0].trim()}"`);
  }
  return signals;
}

/** Signals of a §4.6 money-movement or trade-order tool. Empty when none. */
export function financialActionSignals(tool: MuseToolEvidence): string[] {
  const signals: string[] = [];
  const text = `${tool.name.replace(/[_-]+/g, " ")} \n ${descriptionOf(tool)}`;
  for (const pattern of MONEY_MOVEMENT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) signals.push(`money movement: "${match[0].trim()}"`);
  }

  const words = nameWords(tool.name);
  const tradeVerb = words.find((word) => TRADE_NAME_WORDS.has(word));
  if (tradeVerb) {
    const properties = Object.keys(
      asSchema(tool.inputSchema)?.properties ?? {}
    );
    const tickerParameter = properties.find((property) =>
      TRADE_PARAMETER_NAMES.has(property.toLowerCase())
    );
    const subject = TRADE_SUBJECT.exec(descriptionOf(tool));
    // A trade VERB alone is e-commerce ("buy_item"). It takes a financial
    // instrument — a ticker parameter or a securities word — to make it a
    // trade order.
    if (tickerParameter || subject) {
      signals.push(
        `trade order: name has "${tradeVerb}" and ${
          tickerParameter
            ? `takes a "${tickerParameter}" parameter`
            : `the description mentions "${subject![0]}"`
        }`
      );
    }
  }
  return signals;
}

// ── The sheet ───────────────────────────────────────────────────────────

/**
 * Suggest a class for one tool, independently of anything declared — so a
 * declared class that disagrees is visible as a disagreement rather than
 * overwritten.
 */
export function suggestMuseToolClass(
  tool: MuseToolEvidence,
  declared?: MuseToolClass
): MuseClassificationRow {
  const reasons: string[] = [];
  const { readOnly } = hints(tool);
  const combined = demonstrableReadWriteVerbs(tool);

  let base: "read" | "write";
  let basis: MuseClassificationBasis;
  if (combined) {
    base = "write";
    basis = "combined-operations";
    reasons.push(
      `"${combined.parameter}" offers both reads (${combined.safe.join(", ")}) and writes (${combined.unsafe.join(", ")}); a combined tool is a write (§3.2)`
    );
  } else if (readOnly === true) {
    base = "read";
    basis = "annotation";
    reasons.push("declares readOnlyHint: true");
  } else if (readOnly === false) {
    base = "write";
    basis = "annotation";
    reasons.push("declares readOnlyHint: false");
  } else {
    base = "write";
    basis = "default";
    reasons.push(
      "declares no readOnlyHint, and MCP's default is not read-only"
    );
  }

  let suggested: MuseToolClass = base;
  if (base === "write") {
    const signals = sensitiveWriteSignals(tool);
    if (signals.length > 0) {
      suggested = "sensitive-write";
      reasons.push(...signals);
    }
  }

  return {
    tool: tool.name,
    suggested,
    basis,
    reasons,
    ...(declared ? { declared } : {}),
  };
}

/** The whole sheet, in listing order. */
export function buildMuseClassificationSheet(
  tools: readonly MuseToolEvidence[],
  declared: Readonly<Record<string, MuseToolClass>> = {}
): MuseClassificationRow[] {
  return tools.map((tool) =>
    suggestMuseToolClass(
      tool,
      Object.prototype.hasOwnProperty.call(declared, tool.name)
        ? declared[tool.name]
        : undefined
    )
  );
}

const CLASS_LABELS: Record<MuseToolClass, string> = {
  read: "Read",
  write: "Write",
  "sensitive-write": "Sensitive write",
};

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Render the sheet as the Markdown table §5.6 asks for in the tool
 * documentation. Uses the declared class where there is one, because the
 * documentation states the submitter's classification, not ours.
 */
export function formatMuseClassificationSheet(
  rows: readonly MuseClassificationRow[]
): string {
  const lines = [
    "| Tool | Classification | Basis |",
    "| --- | --- | --- |",
    ...rows.map((row) => {
      const label = CLASS_LABELS[row.declared ?? row.suggested];
      const basis = row.declared
        ? row.declared === row.suggested
          ? "declared; matches the suggestion"
          : `declared; suggested ${CLASS_LABELS[row.suggested]}: ${row.reasons.join("; ")}`
        : `suggested: ${row.reasons.join("; ")}`;
      return `| \`${cell(row.tool)}\` | ${label} | ${cell(basis)} |`;
    }),
  ];
  return lines.join("\n");
}
