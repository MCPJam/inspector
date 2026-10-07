/**
 * Tool-listing checks: two deterministic requirements in the tool-policy lane,
 * four heuristics in experience-insights.
 *
 * THE SPLIT IS THE POINT. Only two of Muse's tool rules can be settled from a
 * listing without guessing:
 *
 *   - a tool whose OWN schema enumerates a read and a write operation, and
 *     whose OWN annotations call it read-only, contradicts §3.2's "a tool that
 *     combines reads and writes must be classified as a write";
 *   - a credential written into a tool's name, description or schema breaks
 *     §4.4's "do not expose them in … tool descriptions".
 *
 * Everything else — is this write sensitive, is this read hiding a payment,
 * does this tool move money, is this description steering the agent — is a
 * judgement about what a tool DOES, made from its words. Those are
 * `heuristic` findings: they can be wrong, they say why they fired, and they
 * can never make a lane `not-ready`.
 *
 * Pure: takes a tool snapshot, returns findings. No transport, no client.
 */

import { demonstrableReadWriteVerbs } from "../../directory-readiness/tool-shape.js";
import {
  buildMuseClassificationSheet,
  concealedWriteSignals,
  financialActionSignals,
  sensitiveWriteSignals,
  type MuseClassificationRow,
  type MuseToolEvidence,
} from "../classification.js";
import { musePolicySource } from "../manifest.js";
import type { MuseToolClass } from "../profile.js";
import type { MuseReadinessFinding } from "../types.js";
import {
  informational,
  MUSE_READINESS_INPUTS,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type MuseCheckDefinition,
  type MuseCheckStamp,
} from "./helpers.js";

const COMBINED_NOT_READ: MuseCheckDefinition = {
  id: "muse.tools.combined-read-write",
  title: "No tool that both reads and writes declares itself read-only",
  lane: "tool-policy",
  class: "required",
  source: musePolicySource("docs", "§3.2 How tools are classified"),
  provenance: "static",
  intrusiveness: "passive",
};

const NO_EXPOSED_SECRETS: MuseCheckDefinition = {
  id: "muse.tools.no-exposed-secrets",
  title: "No credential appears in a tool's name, description or schema",
  lane: "tool-policy",
  class: "required",
  source: musePolicySource("docs", "§4.4 Security"),
  provenance: "static",
  intrusiveness: "passive",
};

const SUGGESTED_CLASSIFICATION: MuseCheckDefinition = {
  id: "muse.tools.suggested-classification",
  title: "Suggested Read / Write / Sensitive-write class for every tool",
  lane: "experience-insights",
  class: "heuristic",
  source: musePolicySource("docs", "§5.6 Tool annotation"),
  provenance: "static",
  intrusiveness: "passive",
};

const SENSITIVE_WRITE_SIGNALS: MuseCheckDefinition = {
  id: "muse.tools.sensitive-write-signals",
  title:
    "No tool presented as a read or plain write looks like a sensitive write",
  lane: "experience-insights",
  class: "heuristic",
  source: musePolicySource("docs", "§3.2 How tools are classified"),
  provenance: "static",
  intrusiveness: "passive",
};

const MONEY_MOVEMENT: MuseCheckDefinition = {
  id: "muse.tools.money-movement",
  title: "No tool moves money between accounts or places a trade order",
  lane: "experience-insights",
  class: "heuristic",
  source: musePolicySource("docs", "§4.6 Finance Connectors"),
  provenance: "static",
  intrusiveness: "passive",
};

const DESCRIPTION_STEERING: MuseCheckDefinition = {
  id: "muse.tools.description-steering",
  title:
    "No tool description instructs the agent instead of describing the tool",
  lane: "experience-insights",
  class: "heuristic",
  source: musePolicySource("docs", "§3.2 How tools are classified"),
  provenance: "static",
  intrusiveness: "passive",
};

const DEFINITIONS = [
  COMBINED_NOT_READ,
  NO_EXPOSED_SECRETS,
  SUGGESTED_CLASSIFICATION,
  SENSITIVE_WRITE_SIGNALS,
  MONEY_MOVEMENT,
  DESCRIPTION_STEERING,
];

// ── Credentials ─────────────────────────────────────────────────────────

/**
 * Credential formats with a fixed, documented shape.
 *
 * Shape-only on purpose. A "long random-looking string" rule would flag every
 * example id and hash in every schema, and this check is `required` — a false
 * positive tells a submitter their listing leaks a secret it does not have.
 */
const CREDENTIAL_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["Stripe secret key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  [
    "API secret key (sk-…)",
    /\bsk-(?:proj-|ant-(?:api\d{2}-)?)?[A-Za-z0-9_-]{20,}/,
  ],
  [
    "GitHub token",
    /\b(?:gh[opsur]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
  ],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["Google OAuth access token", /\bya29\.[0-9A-Za-z_-]{20,}/],
  [
    "JSON Web Token",
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ],
  ["private key block", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  [
    "URL with an embedded password",
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/i,
  ],
];

/** Passwords that are obviously a placeholder in a connection-string example. */
const PLACEHOLDER_PASSWORD =
  /^(?:password|passwd|pass|secret|xxx+|\*+|<[^>]*>|\{[^}]*\}|\$\{?[A-Za-z_]+\}?)$/i;

/**
 * A documentation placeholder has the shape of a key and none of its
 * meaning. Two tells: low entropy (`sk_test_xxxxxxxxxxxxxxxx` — real keys of
 * every format above use well over ten distinct characters), and the word
 * vendors put in their own published examples (`AKIAIOSFODNN7EXAMPLE`).
 */
const PLACEHOLDER_WORD = /example|sample|dummy|placeholder|redacted/i;

function isPlaceholder(match: string): boolean {
  return new Set(match).size < 10 || PLACEHOLDER_WORD.test(match);
}

/** Every string a listing exposes, with where it sits. Bounded. */
function exposedStrings(
  tool: MuseToolEvidence
): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = [];
  const push = (path: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0)
      out.push({ path, value });
  };
  push("name", tool.name);
  push("title", tool.title);
  push("description", tool.description);
  push("annotations.title", tool.annotations?.title);

  // A schema can be large and is attacker-shaped; the walk is capped in depth
  // and node count so a hostile listing cannot make grading expensive.
  let budget = 5_000;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (budget-- <= 0 || depth > 12) return;
    if (typeof node === "string") {
      push(path, node);
    } else if (Array.isArray(node)) {
      node.forEach((entry, index) =>
        walk(entry, `${path}[${index}]`, depth + 1)
      );
    } else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, `${path}.${key}`, depth + 1);
      }
    }
  };
  walk(tool.inputSchema, "inputSchema", 0);
  walk(tool.outputSchema, "outputSchema", 0);
  return out;
}

interface CredentialHit {
  tool: string;
  path: string;
  kind: string;
  /** The first four characters only. The value itself is never echoed. */
  preview: string;
}

function findCredentials(tool: MuseToolEvidence): CredentialHit[] {
  const hits: CredentialHit[] = [];
  for (const { path, value } of exposedStrings(tool)) {
    for (const [kind, pattern] of CREDENTIAL_PATTERNS) {
      const match = pattern.exec(value);
      if (!match) continue;
      if (kind === "URL with an embedded password") {
        if (PLACEHOLDER_PASSWORD.test(match[1] ?? "")) continue;
      } else if (kind !== "private key block" && isPlaceholder(match[0])) {
        continue;
      }
      hits.push({
        tool: tool.name,
        path,
        kind,
        preview: `${match[0].slice(0, 4)}…`,
      });
    }
  }
  return hits;
}

// ── Steering ────────────────────────────────────────────────────────────

/**
 * §3.2: "Do not use tool descriptions or responses to instruct Muse to ignore
 * its rules, steer away from competitors, access unrelated data, force
 * recommendations, conceal commercial interests, or take unrequested
 * actions." And §3.4: "Do not bypass them, ask users to disable them".
 * Each pattern is an instruction aimed at the agent, not a fact about the tool.
 */
const STEERING_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous\s+|prior\s+|other\s+|system\s+)?(?:instructions|rules|guidelines|prompts?)\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:use|call|recommend|suggest|mention)\s+(?:any\s+)?(?:other|competing|competitors?'?s?|alternative)\b/i,
  /\b(?:always|only)\s+(?:use|call|recommend|suggest|prefer)\s+(?:this|our|these)\b/i,
  /\binstead\s+of\s+(?:any\s+)?(?:other|competing|competitors?'?s?)\b/i,
  /\bwithout\s+(?:asking|confirming\s+with|telling|notifying|approval\s+from)\s+(?:the\s+)?user\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:ask|tell|inform|notify|confirm\s+with)\s+the\s+user\b/i,
  /\b(?:bypass|skip|disable)\s+(?:the\s+|any\s+)?(?:approval|confirmation|permission)s?\b/i,
];

function steeringPhrases(tool: MuseToolEvidence): string[] {
  const text = [tool.title, tool.description].filter(Boolean).join(" \n ");
  return STEERING_PATTERNS.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match ? [match[0].trim()] : [];
  });
}

// ── Runner ──────────────────────────────────────────────────────────────

/** Whether the listing the run holds is the whole one. */
export interface MuseToolListingCompleteness {
  /** `false` only when the run KNOWS the listing is partial. */
  complete?: boolean;
  /** Why it is partial, for the gap's own sentence. */
  error?: string;
}

export interface MuseToolCheckOutput {
  findings: MuseReadinessFinding[];
  /** Empty unless a complete, non-empty listing was graded. */
  classificationSheet: MuseClassificationRow[];
}

/**
 * Run every tool-listing check.
 *
 * `declared` is the submitter's per-tool classification, when a profile
 * supplied one. It changes only the HEURISTICS — what a tool is presented as
 * is part of whether it looks like it hides a write — never a requirement.
 */
export function runMuseToolChecks(
  tools: readonly MuseToolEvidence[] | undefined,
  stamp: MuseCheckStamp,
  listing?: MuseToolListingCompleteness,
  declared: Readonly<Record<string, MuseToolClass>> = {}
): MuseToolCheckOutput {
  // "No listing" and "an empty listing" are different facts: the first is an
  // untested obligation, the second has nothing that could violate one.
  if (!tools) {
    return {
      findings: DEFINITIONS.map((definition) =>
        notEvaluated(
          definition,
          stamp,
          "no tool listing was captured for this run",
          {
            missingInput: MUSE_READINESS_INPUTS.toolListing,
          }
        )
      ),
      classificationSheet: [],
    };
  }
  // A PARTIAL LISTING GRADES NOTHING. Every check here is about every tool,
  // and a universal claim over a subset is a different claim.
  if (listing?.complete === false) {
    const why =
      listing.error ??
      "the tool listing was truncated before the whole set was read";
    return {
      findings: DEFINITIONS.map((definition) =>
        notEvaluated(
          definition,
          stamp,
          `${why}, so a requirement about every tool cannot be graded`,
          {
            missingInput: MUSE_READINESS_INPUTS.toolListing,
            toolsRead: tools.length,
          }
        )
      ),
      classificationSheet: [],
    };
  }
  if (tools.length === 0) {
    return {
      findings: DEFINITIONS.map((definition) =>
        notApplicable(
          definition,
          stamp,
          "the server advertises no tools, so there is nothing to grade"
        )
      ),
      classificationSheet: [],
    };
  }

  const findings: MuseReadinessFinding[] = [];

  // §3.2 — combined tools must be writes. Only the server's OWN read-only
  // claim can contradict that from a listing; a combined tool annotated as a
  // write is fine (and will simply prompt on its reads).
  const combined = tools.flatMap((tool) => {
    const evidence = demonstrableReadWriteVerbs(tool);
    return evidence ? [{ tool, evidence }] : [];
  });
  const combinedClaimingRead = combined.filter(
    ({ tool }) => tool.annotations?.readOnlyHint === true
  );
  findings.push(
    combinedClaimingRead.length === 0
      ? satisfied(COMBINED_NOT_READ, stamp, {
          combinedTools: combined.map(({ tool }) => tool.name),
        })
      : violated(
          COMBINED_NOT_READ,
          stamp,
          "These tools enumerate both read and write operations but declare readOnlyHint: true. Muse classifies a combined tool as a write — clear the hint, or split the reads into their own tool.",
          {
            tools: combinedClaimingRead.map(({ tool, evidence }) => ({
              name: tool.name,
              parameter: evidence.parameter,
              readValues: evidence.safe,
              writeValues: evidence.unsafe,
            })),
          }
        )
  );

  const credentials = tools.flatMap(findCredentials);
  findings.push(
    credentials.length === 0
      ? satisfied(NO_EXPOSED_SECRETS, stamp, { toolCount: tools.length })
      : violated(
          NO_EXPOSED_SECRETS,
          stamp,
          "Remove these credentials from the tool listing and rotate them — anything in a tool definition is sent to every client that lists your tools.",
          { hits: credentials }
        )
  );

  const sheet = buildMuseClassificationSheet(tools, declared);
  const counts = { read: 0, write: 0, "sensitive-write": 0 };
  for (const row of sheet) counts[row.suggested] += 1;
  findings.push(
    informational(
      SUGGESTED_CLASSIFICATION,
      stamp,
      { counts, rows: sheet },
      "A starting point for the per-tool classification your documentation must carry (§5.6). Meta makes the final call in review."
    )
  );

  // §3.2 concealment and under-classification. What a tool is PRESENTED as is
  // the submitter's declaration when there is one, and the sheet otherwise.
  interface Flagged {
    tool: string;
    presentedAs: MuseToolClass;
    concern: string;
    signals: string[];
  }
  const flagged = sheet.flatMap((row, index): Flagged[] => {
    const tool = tools[index]!;
    const presentedAs = row.declared ?? row.suggested;
    if (presentedAs === "read") {
      const signals = concealedWriteSignals(tool);
      return signals.length > 0
        ? [
            {
              tool: row.tool,
              presentedAs,
              concern: "may hide a write",
              signals,
            },
          ]
        : [];
    }
    if (row.declared === "write") {
      const signals = sensitiveWriteSignals(tool);
      return signals.length > 0
        ? [
            {
              tool: row.tool,
              presentedAs,
              concern: "may be a sensitive write",
              signals,
            },
          ]
        : [];
    }
    return [];
  });
  findings.push(
    flagged.length === 0
      ? satisfied(SENSITIVE_WRITE_SIGNALS, stamp, {
          suggestedSensitive: sheet
            .filter((row) => row.suggested === "sensitive-write")
            .map((row) => row.tool),
        })
      : violated(
          SENSITIVE_WRITE_SIGNALS,
          stamp,
          "Review these tools: their names or descriptions suggest a send, share, publish, payment or other irreversible action. Muse requires those to be Sensitive writes, approved on every use.",
          { tools: flagged }
        )
  );

  const financial = tools.flatMap((tool) => {
    const signals = financialActionSignals(tool);
    return signals.length > 0 ? [{ tool: tool.name, signals }] : [];
  });
  findings.push(
    financial.length === 0
      ? satisfied(MONEY_MOVEMENT, stamp)
      : violated(
          MONEY_MOVEMENT,
          stamp,
          "Muse is not currently approving tools that move money between financial accounts or place trade orders. Expect these tools to be left out of approval; read access to financial data is allowed.",
          { tools: financial }
        )
  );

  const steering = tools.flatMap((tool) => {
    const phrases = steeringPhrases(tool);
    return phrases.length > 0 ? [{ tool: tool.name, phrases }] : [];
  });
  findings.push(
    steering.length === 0
      ? satisfied(DESCRIPTION_STEERING, stamp)
      : violated(
          DESCRIPTION_STEERING,
          stamp,
          "Rewrite these descriptions as facts about what the tool does. Muse rejects descriptions that tell it to ignore its rules, avoid competitors, or act without asking the user.",
          { tools: steering }
        )
  );

  return { findings, classificationSheet: sheet };
}
