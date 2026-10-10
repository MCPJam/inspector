/**
 * Which models a harness runtime can run, keyed by the runtime's VERSION.
 *
 * The rules are an evidence table, not constants: every row names the harness,
 * the runtime versions it was observed on, the model family it covers, the
 * verdict, the evidence for it and when it was observed. The table itself is
 * data — `harness-model-support-evidence.json` beside this file — because the
 * backend's lease rule reads the SAME rows (it keeps a byte-for-byte mirror and
 * pins its hash), so the two sides cannot disagree about a harness × model
 * pair. Edit the JSON, never a copy of its rules in code.
 *
 * A verdict is three-valued on purpose:
 *
 *  - `supported`   — measured or documented to work on this runtime version.
 *  - `unsupported` — measured or documented NOT to work (the runtime would
 *                    silently substitute its own model, or run it without
 *                    tools). Refused everywhere.
 *  - `unknown`     — nobody has checked this pair on this version. Refused for
 *                    evals and swarms ("not verified for <harness> <version>"),
 *                    allowed in Playground chat with a warning.
 *
 * Shared by the server registry (`server/utils/harness/registry.ts`), the
 * admission gates, and the client pickers, so a picker never offers what the
 * server would refuse.
 */
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import evidenceTable from "./harness-model-support-evidence.json" with { type: "json" };

export type HarnessModelSupportStatus = "supported" | "unsupported" | "unknown";

/** One evidence row, exactly as it appears in the JSON table. */
export type HarnessModelSupportRow = {
  harness: string;
  /** `"*"` (any version, including an unknown one), `"<=A.B.x"` or `">A.B.x"`. */
  versionRange: string;
  /** Regular expression tested against the normalized canonical model id. */
  familyPattern: string;
  status: HarnessModelSupportStatus;
  evidence: string;
  /** ISO date the evidence was observed. */
  observedAt: string;
};

export type HarnessModelSupportVerdict = {
  status: HarnessModelSupportStatus;
  /** Human copy. For `unknown` it always reads
   *  `not verified for <harness> <version>`. */
  reason: string;
  /** The row that decided the verdict, when one did. */
  evidence?: HarnessModelSupportRow;
};

/**
 * Where a model is about to run, which decides what an `unknown` verdict means:
 * evals and swarms produce results someone will compare, so an unverified pair
 * is refused; Playground chat is exploratory, so it runs with a warning.
 */
export type HarnessModelPurpose = "chat" | "eval" | "swarm";

export const HARNESS_MODEL_SUPPORT_ROWS: readonly HarnessModelSupportRow[] =
  evidenceTable.rows as HarnessModelSupportRow[];

/**
 * The runtime CLI version each harness adapter pins — the version the evidence
 * rows are evaluated against when nothing more specific is known.
 *
 *  - `claude-code`: `@anthropic-ai/claude-code` in the bridge package the
 *    installed `@ai-sdk/harness-claude-code` bootstraps.
 *  - `codex`: `@openai/codex` in the app-server bootstrap
 *    (`PINNED_CODEX_VERSION`).
 *  - `cursor`: the CLI build `cursor-bootstrap.ts` installs. Cursor's own
 *    installer serves whatever is current, so the hosted bootstrap replaces it
 *    with a checksummed download of exactly this build. Its evidence rows are
 *    all version-independent; the pin exists so the baked template, the box and
 *    the recorded session version can be compared.
 *
 * Asserted against the installed packages in the registry tests; bump here in
 * the same change that bumps an adapter.
 */
export const HARNESS_PINNED_VERSIONS = {
  "claude-code": "2.1.245",
  codex: "0.149.1",
  // The Cursor CLI build the hosted bootstrap installs (and the computer
  // template bakes), by the version string Cursor's own installer stamps in.
  // `server/utils/harness/cursor-bootstrap.ts` pins the download to exactly
  // this build with a checksum per platform; bump both together.
  cursor: "2026.10.01-e373342",
} as const satisfies Record<Harness, string | null>;

/** The pinned runtime version for a harness id, or undefined when the harness
 *  is unknown or its version is not pinned. */
export function harnessPinnedVersion(harnessId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(
    HARNESS_PINNED_VERSIONS,
    harnessId,
  )
    ? (HARNESS_PINNED_VERSIONS[harnessId as Harness] ?? undefined)
    : undefined;
}

/**
 * The organization provider connections each BROKERED harness can run on: its
 * own vendor's native API, on the organization's key. Claude Code speaks
 * Anthropic Messages and Codex speaks OpenAI Responses, so a turn whose saved
 * selection names an org Anthropic (resp. OpenAI) connection runs on that
 * key through MCPJam's model proxy. Cursor authenticates with the customer's
 * own Cursor account and runs on no org connection.
 *
 * This is the preflight's answer from non-secret metadata; the backend still
 * resolves the connection id authoritatively at lease start and refuses a
 * mismatch (`provider_mismatch`).
 */
export const HARNESS_ORG_PROVIDER_KEYS = {
  "claude-code": ["anthropic"],
  codex: ["openai"],
  cursor: [],
} as const satisfies Record<Harness, readonly string[]>;

/** Whether `harnessId` can run on an org connection to `providerKey`. */
export function harnessRunsOnOrgProvider(
  harnessId: string,
  providerKey: string | undefined,
): boolean {
  if (!providerKey) return false;
  const keys: readonly string[] = Object.prototype.hasOwnProperty.call(
    HARNESS_ORG_PROVIDER_KEYS,
    harnessId,
  )
    ? HARNESS_ORG_PROVIDER_KEYS[harnessId as Harness]
    : [];
  return keys.includes(providerKey);
}

/**
 * Which upstream a harness runtime is configured for, as the backend resolved
 * it at lease start. Non-secret. The Gateway profile keeps the Gateway's
 * Claude model spellings and effort workarounds; a native profile talks to the
 * vendor's own API with native model ids.
 */
export type HarnessUpstreamProfile =
  "gateway" | "anthropic-native" | "openai-native";

const ORG_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** The refusal copy for an org connection the harness cannot run on. */
export function harnessOrgProviderUnsupportedReason(harnessId: string): string {
  const name = harnessDisplayName(harnessId);
  const keys: readonly string[] = Object.prototype.hasOwnProperty.call(
    HARNESS_ORG_PROVIDER_KEYS,
    harnessId,
  )
    ? HARNESS_ORG_PROVIDER_KEYS[harnessId as Harness]
    : [];
  const vendors = keys.map((key) => ORG_PROVIDER_LABELS[key] ?? key);
  return vendors.length > 0
    ? `the ${name} harness runs MCPJam-provided models or your organization's ${vendors.join(" or ")} key`
    : `the ${name} harness does not run on an organization's provider key`;
}

/** Human-facing runtime names (same values as the registry's `displayName`). */
const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor CLI",
};

function harnessDisplayName(harnessId: string): string {
  return HARNESS_DISPLAY_NAMES[harnessId] ?? harnessId;
}

// ── Versions ─────────────────────────────────────────────────────────────────

/** `[major, minor, patch]`, or undefined when the string is not a version. A
 *  leading `v` and any prerelease/build suffix are tolerated. */
export function parseHarnessVersion(
  version: string | null | undefined,
): [number, number, number] | undefined {
  if (typeof version !== "string") return undefined;
  const match = version.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Compare two parsed versions on major.minor only (patch ignored). */
function compareMajorMinor(
  a: readonly [number, number, number],
  b: readonly [number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

type ParsedRange =
  { kind: "any" } | { kind: "lte" | "gt"; bound: [number, number] };

function parseVersionRange(range: string): ParsedRange | undefined {
  if (range === "*") return { kind: "any" };
  const match = range.match(/^(<=|>)(\d+)\.(\d+)\.x$/);
  if (!match) return undefined;
  return {
    kind: match[1] === "<=" ? "lte" : "gt",
    bound: [Number(match[2]), Number(match[3])],
  };
}

/** Is `range` well-formed (`"*"`, `"<=A.B.x"` or `">A.B.x"`)? */
export function isValidHarnessVersionRange(range: string): boolean {
  return parseVersionRange(range) !== undefined;
}

/**
 * Does `range` admit `version`? `"*"` admits anything, including an unknown
 * version. A version-specific range never admits an unknown/unparseable
 * version, nor does a malformed range admit anything.
 */
export function harnessVersionInRange(
  range: string,
  version: string | null | undefined,
): boolean {
  const parsedRange = parseVersionRange(range);
  if (!parsedRange) return false;
  if (parsedRange.kind === "any") return true;
  const parsed = parseHarnessVersion(version);
  if (!parsed) return false;
  const cmp = compareMajorMinor(parsed, parsedRange.bound);
  return parsedRange.kind === "lte" ? cmp <= 0 : cmp > 0;
}

// ── Model ids ────────────────────────────────────────────────────────────────

const CLAUDE_FAMILY_ID =
  /^claude-(haiku|sonnet|opus)-(\d+)(?:-\d{8}|[.-](\d+)(?:-\d{8})?)?$/;

/**
 * Normalize a model id to the canonical spelling the evidence rows match:
 * lower-case, provider-prefixed (`claude-*` → `anthropic/`, `gpt-*` →
 * `openai/` when bare), and Anthropic family ids spelled with a dotted minor
 * and no date suffix (`claude-sonnet-4-5-20250929` → `claude-sonnet-4.5`), the
 * same family/major/minor the Claude Code adapter maps to its native id.
 *
 * Callers should still canonicalize with the provider first
 * (`getCanonicalModelId`); this only makes the table robust to the spellings
 * that reach it anyway.
 */
export function normalizeHarnessModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  if (!id.includes("/")) {
    if (id.startsWith("claude-")) id = `anthropic/${id}`;
    else if (id.startsWith("gpt-")) id = `openai/${id}`;
  }
  if (id.startsWith("anthropic/")) {
    const slug = id.slice("anthropic/".length);
    const match = slug.match(CLAUDE_FAMILY_ID);
    if (match) {
      const [, family, major, minor] = match;
      id = `anthropic/claude-${family}-${major}${minor ? `.${minor}` : ""}`;
    }
  }
  return id;
}

// ── Verdict ──────────────────────────────────────────────────────────────────

function notVerifiedReason(
  harnessId: string,
  runtimeVersion: string | null | undefined,
): string {
  const version =
    typeof runtimeVersion === "string" && runtimeVersion.trim()
      ? runtimeVersion.trim()
      : "(unknown version)";
  return `not verified for ${harnessId} ${version}`;
}

/** The refusal copy for an `unsupported` verdict — the same sentence the
 *  harness pre-flight has always used for a model the runtime can't run. */
export function harnessModelUnsupportedReason(harnessId: string): string {
  const name = harnessDisplayName(harnessId);
  return (
    `the ${name} harness can't run this host's model — pick a ` +
    `${name}-compatible model to run the real runtime`
  );
}

/**
 * Can `harnessId` at `runtimeVersion` run `modelId`?
 *
 * Rows are evaluated in order and the first match wins. A row matches when its
 * harness is `harnessId`, its `familyPattern` matches the normalized model id,
 * and its `versionRange` admits `runtimeVersion`. When the version is missing
 * or unparseable and a VERSION-SPECIFIC row's pattern matches, the verdict is
 * `unknown` — the table has evidence for some versions of this pair, but
 * cannot say which one is running. A harness with no rows, or a model no row
 * covers, is `unknown` too.
 */
export function harnessModelSupport(args: {
  harnessId: string;
  runtimeVersion?: string | null;
  modelId: string;
  /** Override the table (tests). Defaults to {@link HARNESS_MODEL_SUPPORT_ROWS}. */
  rows?: readonly HarnessModelSupportRow[];
}): HarnessModelSupportVerdict {
  const rows = args.rows ?? HARNESS_MODEL_SUPPORT_ROWS;
  const modelId = normalizeHarnessModelId(args.modelId);
  const versionKnown = parseHarnessVersion(args.runtimeVersion) !== undefined;
  const unknown = (evidence?: HarnessModelSupportRow) => ({
    status: "unknown" as const,
    reason: notVerifiedReason(args.harnessId, args.runtimeVersion),
    ...(evidence ? { evidence } : {}),
  });

  for (const row of rows) {
    if (row.harness !== args.harnessId) continue;
    let pattern: RegExp;
    try {
      pattern = new RegExp(row.familyPattern);
    } catch {
      continue;
    }
    if (!pattern.test(modelId)) continue;
    if (row.versionRange !== "*") {
      if (!versionKnown) return unknown(row);
      if (!harnessVersionInRange(row.versionRange, args.runtimeVersion)) {
        continue;
      }
    }
    switch (row.status) {
      case "supported":
        return { status: "supported", reason: row.evidence, evidence: row };
      case "unsupported":
        return {
          status: "unsupported",
          reason: harnessModelUnsupportedReason(args.harnessId),
          evidence: row,
        };
      default:
        return unknown(row);
    }
  }
  return unknown();
}

/** {@link harnessModelSupport} at the harness adapter's pinned CLI version. */
export function harnessModelSupportAtPinnedVersion(args: {
  harnessId: string;
  modelId: string;
}): HarnessModelSupportVerdict {
  return harnessModelSupport({
    harnessId: args.harnessId,
    runtimeVersion: harnessPinnedVersion(args.harnessId),
    modelId: args.modelId,
  });
}

/**
 * Does a verdict admit the model for `purpose`? `supported` always does,
 * `unsupported` never does, and `unknown` only in Playground chat (where the
 * caller shows the verdict's reason as a warning).
 */
export function harnessModelVerdictAdmits(
  verdict: Pick<HarnessModelSupportVerdict, "status">,
  purpose: HarnessModelPurpose,
): boolean {
  if (verdict.status === "supported") return true;
  if (verdict.status === "unknown") return purpose === "chat";
  return false;
}
