/**
 * `deriveOAuthEmulation` — compile an evidence-backed OAuth profile into the
 * generic machine knobs and the client's authentication ladder (HP-43).
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
  OAuthAuthModel,
  OAuthDcrIdentity,
  OAuthProfileEvidence,
  OAuthScopeRequest,
  OAuthSpecVersionClaim,
  OAuthTokenEndpointAuthMethod,
} from "../../host-config/types.js";
import type { OAuthProtocolVersion } from "../state-machines/types.js";
import type {
  EmulatedAuthAttempt,
  EmulatedRegistrationPreference,
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
  /**
   * The client's authentication ladder, in profile order. Executed by
   * `runEmulatedOAuthPreflight`; a profile with no `authModel` evidence yields
   * a single OAuth attempt with no strategy preference (today's AUTO order).
   */
  authAttempts: EmulatedAuthAttempt[];
  /**
   * Redirect URIs observed in the real client's registration, in captured
   * order. Deliberately NOT copied into `emulation.dcrRedirectUris`: replaying
   * them alone would send the authorization code somewhere MCPJam cannot
   * receive it. The runner combines them with its own callback
   * (`planCompletionSafeRedirects`) and reports the difference.
   */
  capturedRedirectUris?: string[];
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
      atOrBelow.length > 0
        ? (atOrBelow.at(-1) as OAuthProtocolVersion)
        : supported[0];
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

const REGISTRATION_PREFERENCE_BY_AUTH_MODEL: Partial<
  Record<OAuthAuthModel, EmulatedRegistrationPreference>
> = {
  "oauth2-dcr": "dcr",
  "oauth2-cimd": "cimd",
  "oauth2-preregistered": "preregistered",
};

/**
 * Compile the ordered `authModel` list into the ladder the runner executes.
 *
 * Consecutive `oauth2-*` entries collapse into ONE oauth attempt carrying
 * their relative order as its registration preference — a client that lists
 * `[oauth2-cimd, oauth2-dcr]` performs a single OAuth dance preferring CIMD,
 * not two dances. `api-key` and `none` stay separate rungs, in position, so a
 * "static bearer first, OAuth on 401" client reproduces that sequence.
 */
function toAuthAttempts(models: OAuthAuthModel[]): EmulatedAuthAttempt[] {
  const attempts: EmulatedAuthAttempt[] = [];
  for (const model of models) {
    const preference = REGISTRATION_PREFERENCE_BY_AUTH_MODEL[model];
    if (preference) {
      const last = attempts.at(-1);
      if (last?.kind === "oauth") {
        last.registrationPreference.push(preference);
      } else {
        attempts.push({ kind: "oauth", registrationPreference: [preference] });
      }
      continue;
    }
    // The canonicalizer guarantees "none" is the sole entry when present.
    attempts.push(model === "api-key" ? { kind: "api-key" } : { kind: "none" });
  }
  return attempts;
}

export function deriveOAuthEmulation(
  profile: HostConfigOAuthProfile
): DerivedOAuthEmulation {
  const divergences: OAuthEmulationDivergence[] = [];
  const emulation: OAuthEmulationConfig = {};
  let capturedRedirectUris: string[] | undefined;
  const coverage: OAuthEmulationCoverage = {
    sendsResourceIndicator: "not_modeled",
    oauthSpecVersion: "not_modeled",
    protocolVersionPinning: "not_modeled",
    scopeRequest: "not_modeled",
    dcrIdentity: "not_modeled",
    tokenEndpointAuthMethod: "not_modeled",
    authModel: "not_modeled",
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

  // ── dcrIdentity → client_name + User-Agent + captured redirects ─────────
  const dcrIdentity = evidenceValue<OAuthDcrIdentity>(profile.dcrIdentity);
  if (dcrIdentity !== undefined) {
    if (dcrIdentity.clientName !== undefined) {
      emulation.dcrClientName = dcrIdentity.clientName;
    }
    if (dcrIdentity.userAgent !== undefined) {
      emulation.userAgent = dcrIdentity.userAgent;
    }
    if (dcrIdentity.redirectUris !== undefined) {
      // The runner appends its own callback and declares that addition (see
      // `capturedRedirectUris` above).
      capturedRedirectUris = [...dcrIdentity.redirectUris];
      if (profile.profileVersion === 1) {
        // V1 canonicalization deduped and SORTED this list, so the captured
        // registration order is not recoverable from a V1 row. Say so rather
        // than presenting a sorted list as an exact replay — only V2 rows
        // preserve wire order.
        divergences.push({
          kind: "not-enforced",
          detail:
            "profile is V1, whose canonicalization sorted dcrIdentity.redirectUris; the client's captured registration order is unavailable and cannot be replayed",
        });
      }
    }
    coverage.dcrIdentity = "modeled";
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

  // ── authModel → ordered attempt ladder ──────────────────────────────────
  let authAttempts: EmulatedAuthAttempt[] = [
    // No evidence: one OAuth attempt with no preference, i.e. today's AUTO
    // precedence in the authorization plan.
    { kind: "oauth", registrationPreference: [] },
  ];
  const authModel = evidenceValue<OAuthAuthModel[]>(profile.authModel);
  // An empty list is rejected by the canonicalizer ("omit the field instead"),
  // but the type cannot express that, and compiling one would yield an EMPTY
  // ladder — a run with no attempts at all, reported as blocked with nothing
  // to explain it. Treat it as no evidence.
  if (authModel !== undefined && authModel.length > 0) {
    authAttempts = toAuthAttempts(authModel);
    coverage.authModel = "modeled";
  }

  const coverageSummary = Object.values(coverage).every(
    (status) => status === "modeled"
  )
    ? "complete"
    : "partial";

  return {
    protocolVersion,
    emulation,
    authAttempts,
    ...(capturedRedirectUris ? { capturedRedirectUris } : {}),
    coverage,
    coverageSummary,
    divergences,
  };
}
