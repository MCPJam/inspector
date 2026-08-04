/**
 * OAuth client emulation — CLI plumbing (HP-43 step 7).
 *
 * The emulator runs behind a feature flag while it rolls out: it registers
 * clients and issues tokens on servers the user names, so it must be opted
 * into deliberately rather than discovered by tab-completion.
 *
 * The CLI takes a PROFILE as data — a JSON file the private backend produces —
 * and never a client name. There is no catalog here to name a client from, by
 * design (see the emulation modules in `@mcpjam/sdk`).
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalizeOAuthProfile } from "@mcpjam/sdk/host-config/internal";
import type { HostConfigOAuthProfile } from "@mcpjam/sdk/host-config/internal";
import type {
  OAuthGoldenTrace,
  EmulatedOAuthPreflightResult,
} from "@mcpjam/sdk";
import { usageError } from "./output.js";

export const OAUTH_EMULATION_FLAG = "MCPJAM_OAUTH_EMULATION";

/**
 * The rollout gate. Off by default: an emulated run performs Dynamic Client
 * Registration and a token exchange against a third-party server, which is not
 * something a user should trigger by accident.
 */
export function assertOAuthEmulationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[OAUTH_EMULATION_FLAG] !== "1") {
    throw usageError(
      `OAuth client emulation is behind a feature flag while it rolls out. ` +
        `Set ${OAUTH_EMULATION_FLAG}=1 to enable it. ` +
        `Note that an emulated run registers a client and may obtain a token ` +
        `on the target server.`,
    );
  }
}

function readJsonFile(filePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw usageError(
      `Cannot read ${label} "${filePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw usageError(`${label} "${filePath}" is not valid JSON`);
  }
}

/**
 * Load a profile and put it through the SDK canonicalizer — the same one the
 * backend uses. A profile that would not survive canonicalization must fail
 * here, loudly, rather than producing a half-enforced emulation.
 */
export function loadOAuthProfileFile(filePath: string): HostConfigOAuthProfile {
  const parsed = readJsonFile(filePath, "OAuth profile");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError("OAuth profile must be a JSON object");
  }
  try {
    const canonical = canonicalizeOAuthProfile(
      parsed as HostConfigOAuthProfile,
    );
    if (!canonical) {
      throw usageError("OAuth profile is empty");
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw usageError(
      `OAuth profile "${filePath}" is not valid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Load a golden capture. Structural validation only — the comparator owns
 * the semantics, and a capture is opaque data produced elsewhere. */
export function loadOAuthGoldenFile(filePath: string): OAuthGoldenTrace {
  const parsed = readJsonFile(filePath, "golden trace");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError("Golden trace must be a JSON object");
  }
  const golden = parsed as Partial<OAuthGoldenTrace>;
  if (typeof golden.profileDigest !== "string" || !golden.profileDigest.trim()) {
    throw usageError(
      "Golden trace must have a non-empty string \"profileDigest\" — a capture " +
        "that names no profile cannot be safely compared against a run",
    );
  }
  if (typeof golden.capturedAt !== "string" || !golden.capturedAt.trim()) {
    throw usageError('Golden trace must have a string "capturedAt" date');
  }
  if (!Array.isArray(golden.steps)) {
    throw usageError('Golden trace must have a "steps" array');
  }
  return golden as OAuthGoldenTrace;
}

/**
 * Write a run's normalized trace in golden shape, so a capture taken today can
 * be compared against tomorrow. `capturedAt` is stamped now — the comparator
 * treats a future or malformed date as stale, so it must be a real one.
 */
export async function writeEmulationTraceFile(
  outputPath: string,
  result: Pick<EmulatedOAuthPreflightResult, "trace">,
  profileDigest: string,
  now: Date = new Date(),
): Promise<string> {
  const resolved = path.resolve(process.cwd(), outputPath);
  const golden: OAuthGoldenTrace = {
    profileDigest,
    capturedAt: now.toISOString().slice(0, 10),
    steps: result.trace,
  };
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(golden, null, 2)}\n`, "utf-8");
  return resolved;
}

/** `Header-Name: value`, the same shape `--header` already uses. */
export function parseStaticCredential(
  value: string,
): { headerName: string; value: string } {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw usageError(
      `Static credential must be in "Header-Name: value" format (got "${value}")`,
    );
  }
  const headerName = value.slice(0, separator).trim();
  const headerValue = value.slice(separator + 1).trim();
  if (!headerName || !headerValue) {
    throw usageError(
      'Static credential must have a non-empty header name and value',
    );
  }
  return { headerName, value: headerValue };
}

/**
 * Map a run onto the CLI's shared exit-code vocabulary (0 pass / 1 failed /
 * 2 usage / 3 incomplete).
 *
 * `stopped_at_redirect` is INCOMPLETE, not a pass: the human leg was never
 * crossed, so the run established nothing about whether this client can
 * actually connect. A mismatched comparison is a FAILURE — that is the
 * emulator reporting the very thing it exists to detect.
 */
export function emulationExitCode(
  result: Pick<EmulatedOAuthPreflightResult, "outcome" | "comparison">,
): number {
  if (result.comparison.status === "mismatched") return 1;
  switch (result.outcome) {
    case "completed":
    case "static_credential_ok":
    case "unauthenticated_ok":
      return 0;
    case "stopped_at_redirect":
      return 3;
    case "blocked":
    case "error":
      return 1;
  }
}

/**
 * Human-readable summary. Every line the emulator is allowed to claim is
 * qualified here the same way the result object qualifies it: the three
 * dimensions stay separate, and a qualified match never prints as parity.
 */
export function renderEmulationResult(
  result: EmulatedOAuthPreflightResult,
): string {
  const lines: string[] = [];
  lines.push(`Server:    ${result.serverUrl}`);
  lines.push(`Ladder:    ${result.protocolVersion}`);
  lines.push(`Outcome:   ${result.outcome}`);
  lines.push(
    `Coverage:  ${result.coverageSummary}` +
      (result.coverageSummary === "partial"
        ? ` (${Object.entries(result.coverage)
            .filter(([, status]) => status === "not_modeled")
            .map(([field]) => field)
            .join(", ")} not modeled)`
        : ""),
  );

  const comparison = result.comparison;
  const qualifiers = comparison.qualifiers.length
    ? ` [${comparison.qualifiers.join(", ")}]`
    : "";
  lines.push(
    `Compared:  ${comparison.status}${
      comparison.reason ? ` (${comparison.reason})` : ""
    }${qualifiers}`,
  );

  lines.push("");
  lines.push("Attempts:");
  for (const attempt of result.attempts) {
    lines.push(
      `  - ${attempt.kind}: ${attempt.status}` +
        (attempt.registrationStrategy
          ? ` via ${attempt.registrationStrategy}`
          : "") +
        (attempt.detail ? ` — ${attempt.detail}` : ""),
    );
  }

  if (comparison.differences.length > 0) {
    lines.push("");
    lines.push("Differences from the real client:");
    for (const difference of comparison.differences) {
      lines.push(`  - [${difference.index}] ${difference.kind}: ${difference.detail}`);
      if (difference.expected !== undefined) {
        lines.push(`      real client: ${difference.expected}`);
      }
      if (difference.actual !== undefined) {
        lines.push(`      this run:    ${difference.actual}`);
      }
    }
  }

  if (result.divergences.length > 0) {
    lines.push("");
    lines.push("Declared divergences:");
    for (const divergence of result.divergences) {
      lines.push(`  - ${divergence.kind}: ${divergence.detail}`);
    }
  }

  lines.push("");
  lines.push(
    `Side effects: ${result.sideEffects.dcrRegistrations} client registration(s), ` +
      `${result.sideEffects.tokensIssued} token(s) issued`,
  );

  if (result.authorizationUrl) {
    lines.push("");
    lines.push(`Authorization URL (a human must visit it):`);
    lines.push(`  ${result.authorizationUrl}`);
  }

  if (result.error) {
    lines.push("");
    lines.push(`Error: ${result.error.message}`);
  }

  return lines.join("\n");
}
