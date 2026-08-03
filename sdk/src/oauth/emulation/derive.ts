/**
 * `deriveOAuthEmulation` — compile an evidence-backed OAuth profile into the
 * generic machine knobs (HP-43 step 4).
 *
 * Evidence rules, applied uniformly:
 *   - `verified` → the value is used, field `modeled`.
 *   - `refuted`  → the envelope's value IS the true value (the refuted CLAIM
 *                  is what was disproven) → used identically, field `modeled`.
 *   - `unverifiable` or absent → field `not_modeled`: the machine keeps
 *                  normal MCPJam behavior for that dimension. Never a guess.
 *
 * The compiler is pure and deterministic: same profile in, same knobs out.
 * The private backend resolves catalog rows to profiles and calls this; no
 * client name ever reaches this module.
 */

import type {
  HostConfigOAuthProfile,
  OAuthDcrIdentity,
  OAuthProfileEvidence,
  OAuthScopeRequest,
  OAuthSpecVersionClaim,
  OAuthTokenEndpointAuthMethod,
} from "../../host-config/types.js";
import type { OAuthProtocolVersion } from "../state-machines/types.js";
import type {
  OAuthEmulationConfig,
  OAuthEmulationCoverage,
  OAuthEmulationDivergence,
} from "./types.js";

/** Ladder versions this inspector speaks, oldest → newest. `YYYY-MM-DD` sorts
 * lexicographically = chronologically, which the narrowing below relies on. */
const SUPPORTED_LADDER_VERSIONS: readonly OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

/** Matches `resolveProtocolVersion`'s default in authorization-plan.ts. */
const DEFAULT_LADDER_VERSION: OAuthProtocolVersion = "2025-11-25";

export interface DerivedOAuthEmulation {
  /**
   * Which of the four state machines runs the ladder. `oauthSpecVersion`
   * SELECTS the machine — same-origin discovery (2025-03-26) is derived from
   * this one fact, never a separate flag.
   */
  protocolVersion: OAuthProtocolVersion;
  /** The machine-facing knobs (`BaseOAuthStateMachineConfig.emulation`). */
  emulation: OAuthEmulationConfig;
  /** Per-field enforcement status. */
  coverage: OAuthEmulationCoverage;
  /** `complete` iff every field is `modeled`. Partial coverage can never
   * claim parity. */
  coverageSummary: "complete" | "partial";
  divergences: OAuthEmulationDivergence[];
}

/** Narrow an evidence envelope to its usable value, or undefined. */
function evidenceValue<T>(
  evidence: OAuthProfileEvidence<T> | undefined
): T | undefined {
  if (!evidence) return undefined;
  if (evidence.status === "unverifiable") return undefined;
  return evidence.value;
}

/**
 * Narrow a spec-version claim to a supported ladder version.
 *
 *   constant  — highest revision we both speak; if the sets are disjoint,
 *               the newest supported revision ≤ the client's newest claim
 *               (a 2024-11-05 client runs the oldest ladder we have), else
 *               the oldest ladder. Disjoint sets record a divergence.
 *   behavioral — the floor if we speak it, else the nearest supported
 *               revision ≥ the floor (the claim is "at least this", so any
 *               ladder ≥ floor honors it), else the newest ladder with a
 *               divergence.
 */
function narrowLadderVersion(
  claim: OAuthSpecVersionClaim,
  divergences: OAuthEmulationDivergence[]
): OAuthProtocolVersion {
  const supported = SUPPORTED_LADDER_VERSIONS;

  if (claim.basis === "constant") {
    const spoken = claim.revisions.filter((revision) =>
      (supported as readonly string[]).includes(revision)
    );
    if (spoken.length > 0) {
      return [...spoken].sort().at(-1) as OAuthProtocolVersion;
    }
    const requested = [...claim.revisions].sort().at(-1) as string;
    const atOrBelow = supported.filter((version) => version <= requested);
    const used =
      atOrBelow.length > 0 ? (atOrBelow.at(-1) as OAuthProtocolVersion) : supported[0];
    divergences.push({
      kind: "version-narrowed",
      detail: `client implements OAuth spec revision(s) ${claim.revisions.join(
        ", "
      )}; nearest supported ladder is ${used}`,
      requested,
      used,
    });
    return used;
  }

  const floor = claim.minimumRevision;
  if ((supported as readonly string[]).includes(floor)) {
    return floor as OAuthProtocolVersion;
  }
  const atOrAbove = supported.filter((version) => version >= floor);
  if (atOrAbove.length > 0) {
    // Any ladder ≥ the behavioral floor honors the claim — no divergence.
    return atOrAbove[0];
  }
  const used = supported.at(-1) as OAuthProtocolVersion;
  divergences.push({
    kind: "version-narrowed",
    detail: `client's behavioral floor ${floor} is newer than every supported ladder; using ${used}`,
    requested: floor,
    used,
  });
  return used;
}

export function deriveOAuthEmulation(
  profile: HostConfigOAuthProfile
): DerivedOAuthEmulation {
  const divergences: OAuthEmulationDivergence[] = [];
  const emulation: OAuthEmulationConfig = {};
  const coverage: OAuthEmulationCoverage = {
    sendsResourceIndicator: "not_modeled",
    oauthSpecVersion: "not_modeled",
    protocolVersionPinning: "not_modeled",
    scopeRequest: "not_modeled",
    dcrIdentity: "not_modeled",
    tokenEndpointAuthMethod: "not_modeled",
  };

  // ── oauthSpecVersion → machine selection ────────────────────────────────
  let protocolVersion: OAuthProtocolVersion = DEFAULT_LADDER_VERSION;
  const specClaim = evidenceValue(profile.oauthSpecVersion);
  if (specClaim !== undefined) {
    protocolVersion = narrowLadderVersion(specClaim, divergences);
    coverage.oauthSpecVersion = "modeled";
  }

  // ── protocolVersionPinning → MCP-leg version (headers + bodies) ─────────
  const pinning = evidenceValue(profile.protocolVersionPinning);
  if (pinning !== undefined) {
    if (pinning.mode === "pinned") {
      emulation.mcpProtocolVersion = pinning.version;
    }
    // "negotiated" is modeled by leaving the machine's own per-version
    // values in place — that IS our closest rendering of negotiation.
    coverage.protocolVersionPinning = "modeled";
  }

  // ── sendsResourceIndicator ──────────────────────────────────────────────
  const sendsResource = evidenceValue(profile.sendsResourceIndicator);
  if (sendsResource !== undefined) {
    emulation.sendResourceIndicator = sendsResource;
    coverage.sendsResourceIndicator = "modeled";
  }

  // ── scopeRequest (V2 only — absent on V1 rows) ──────────────────────────
  const scopeRequest =
    profile.profileVersion === 2
      ? evidenceValue<OAuthScopeRequest>(profile.scopeRequest)
      : undefined;
  if (scopeRequest !== undefined) {
    emulation.scopeRequest = scopeRequest;
    coverage.scopeRequest = "modeled";
  }

  // ── dcrIdentity → client_name + User-Agent ──────────────────────────────
  const dcrIdentity = evidenceValue<OAuthDcrIdentity>(profile.dcrIdentity);
  if (dcrIdentity !== undefined) {
    if (dcrIdentity.clientName !== undefined) {
      emulation.dcrClientName = dcrIdentity.clientName;
    }
    if (dcrIdentity.userAgent !== undefined) {
      emulation.userAgent = dcrIdentity.userAgent;
    }
    if (
      dcrIdentity.clientName !== undefined ||
      dcrIdentity.userAgent !== undefined
    ) {
      coverage.dcrIdentity = "modeled";
    }
    if (
      dcrIdentity.redirectUris !== undefined &&
      coverage.dcrIdentity === "not_modeled"
    ) {
      // Captured redirect URIs are real evidence, but their replay belongs
      // to the completion-safe-redirect step of the attempt ladder — nothing
      // in this compiler enforces them yet, and claiming coverage for
      // unenforced evidence would overstate parity.
      divergences.push({
        kind: "not-enforced",
        detail:
          "dcrIdentity captures only redirectUris; redirect replay is handled by the attempt ladder, not this compiler",
      });
    }
  }

  // ── tokenEndpointAuthMethod (V2 only) ───────────────────────────────────
  const tokenAuth =
    profile.profileVersion === 2
      ? evidenceValue<OAuthTokenEndpointAuthMethod>(
          profile.tokenEndpointAuthMethod
        )
      : undefined;
  if (tokenAuth !== undefined) {
    emulation.tokenEndpointAuthMethod = tokenAuth;
    coverage.tokenEndpointAuthMethod = "modeled";
  }

  const coverageSummary = Object.values(coverage).every(
    (status) => status === "modeled"
  )
    ? "complete"
    : "partial";

  return { protocolVersion, emulation, coverage, coverageSummary, divergences };
}
