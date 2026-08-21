/**
 * Side-effecting OAuth probes, and the gate that is the actual product here.
 *
 * WHAT MAKES THESE DIFFERENT. Everything else in readiness reads metadata. These
 * three register a client at someone's authorization server, spend a refresh
 * token and deliberately burn it, and drive a real tool call to force a
 * step-up. Each one leaves a trace in a stranger's system. Run by accident —
 * on a schedule, across a directory feed, against a production tenant — they
 * are indistinguishable from an attack.
 *
 * SO THE GATE IS SDK-ENFORCED, NOT CALL-SITE-ENFORCED. {@link
 * resolveClaudeIntrusiveMode} is the only way to obtain the token these probes
 * require, and it refuses unless every condition below is met. A call site
 * cannot opt in by passing a flag it invented, and a future surface that
 * forgets to check gets a refusal rather than a silent registration.
 *
 * The conditions, and why each one:
 *
 *   1. `enabled: true` as a literal boolean. A truthy string from a query
 *      parameter or a YAML file must not be able to arm this.
 *   2. A stated `grantOrigin`. The probes may only ever use a grant this run
 *      acquired or a dedicated test account the caller owns. BORROWED
 *      CREDENTIALS ARE REFUSED OUTRIGHT: burning a refresh token that belongs
 *      to a real user's live session logs them out of a product they were
 *      using, and no readiness grade is worth that.
 *   3. A declared tool and expected scopes before a step-up probe runs. Calling
 *      an arbitrary tool to see what happens is how a readiness run deletes
 *      someone's data.
 *   4. Cleanup is on unless the caller explicitly turns it off, and a
 *      registration that cannot be cleaned up is reported rather than hidden.
 */

import { parseBearerAuthenticateParameters } from "../oauth/state-machines/shared/challenges.js";
import { claudePolicySource } from "./manifest.js";
import type { ClaudeReadinessFinding } from "./types.js";
import {
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./checks/helpers.js";

/**
 * Where the grant these probes spend came from.
 *
 * There is deliberately no `"caller-supplied"` member. A token handed in for
 * ordinary operation belongs to whoever authorized it, and spending it here
 * would be using someone's session to run a test they did not agree to.
 */
export type ClaudeGrantOrigin = "self-acquired" | "dedicated-test-account";

export interface ClaudeIntrusiveConfig {
  /** Literal `true`. A truthy value of any other type is refused. */
  enabled: boolean;
  /** Required. See {@link ClaudeGrantOrigin}. */
  grantOrigin?: ClaudeGrantOrigin;
  /** Credentials for a dedicated test account, when that is the origin. */
  testCredentials?: {
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
  };
  /** The tool the step-up probe is allowed to call. Nothing else may be called. */
  protectedToolName?: string;
  /** Scopes that tool is expected to require. */
  expectedScopes?: string[];
  /** Delete registered clients afterwards. Defaults to true. */
  cleanup?: boolean;
}

export type ClaudeIntrusiveMode =
  | {
      enabled: false;
      /** Why, in words a caller can act on or show a user. */
      reason: string;
    }
  | {
      enabled: true;
      grantOrigin: ClaudeGrantOrigin;
      credentials: NonNullable<ClaudeIntrusiveConfig["testCredentials"]>;
      protectedToolName?: string;
      expectedScopes?: string[];
      cleanup: boolean;
      /**
       * Present only on an armed mode, and required by every probe below. It
       * cannot be constructed outside this module, which is what makes the
       * gate structural rather than a convention.
       */
      readonly authorization: IntrusiveAuthorization;
    };

/**
 * The unforgeable capability.
 *
 * The BRAND is compile-time only, and a type-level guarantee evaporates at the
 * first `as` cast or the first JavaScript caller. What makes the gate real is
 * {@link assertArmed} below, which compares against this exact object — so a
 * hand-built `{enabled: true, …}` reaches a throw rather than a client
 * registration at somebody else's authorization server.
 */
declare const INTRUSIVE_BRAND: unique symbol;
export interface IntrusiveAuthorization {
  readonly [INTRUSIVE_BRAND]: true;
}
const AUTHORIZATION = Object.freeze({}) as IntrusiveAuthorization;

/**
 * Refuse any mode that did not come out of {@link resolveClaudeIntrusiveMode}.
 *
 * Every probe calls this BEFORE its first request. Without it the module's
 * claim that the capability "cannot be constructed outside this module" is
 * true of the type and false of the runtime, which is the worse of the two
 * places for it to be true.
 */
function assertArmed(mode: ClaudeIntrusiveMode): asserts mode is Extract<
  ClaudeIntrusiveMode,
  { enabled: true }
> {
  if (mode.enabled !== true || mode.authorization !== AUTHORIZATION) {
    throw new Error(
      "Intrusive probes require a mode returned by resolveClaudeIntrusiveMode.",
    );
  }
}

/**
 * The one door in.
 *
 * Returns a disabled mode with a reason for every path that is not a complete,
 * explicit opt-in. `undefined` config is the overwhelmingly common case and is
 * not an error — it is the default, and the default is off.
 */
export function resolveClaudeIntrusiveMode(
  config: ClaudeIntrusiveConfig | undefined,
  context: {
    /**
     * True when the run holds an access token supplied for ORDINARY operation.
     * Its presence does not enable anything; it is passed so the resolver can
     * refuse to let a borrowed token become the grant these probes spend.
     */
    hasBorrowedAccessToken: boolean;
  },
): ClaudeIntrusiveMode {
  if (!config) {
    return { enabled: false, reason: "intrusive probes were not requested" };
  }
  // A literal boolean, not a truthy value. `enabled: "false"` from a config
  // file must not arm client registration against a stranger's server.
  if (config.enabled !== true) {
    return {
      enabled: false,
      reason:
        "intrusive probes require `enabled: true` as a boolean; any other value is treated as off",
    };
  }
  if (
    config.grantOrigin !== "self-acquired" &&
    config.grantOrigin !== "dedicated-test-account"
  ) {
    return {
      enabled: false,
      reason:
        "intrusive probes require an explicit `grantOrigin` of `self-acquired` or `dedicated-test-account`",
    };
  }
  if (
    config.grantOrigin === "dedicated-test-account" &&
    !config.testCredentials?.clientId
  ) {
    return {
      enabled: false,
      reason:
        "`grantOrigin: \"dedicated-test-account\"` requires `testCredentials.clientId`",
    };
  }
  if (context.hasBorrowedAccessToken && config.grantOrigin === "self-acquired") {
    // ONLY `self-acquired` is refused here, and the asymmetry is the point. A
    // `dedicated-test-account` run spends `testCredentials.refreshToken` —
    // credentials the caller owns — and never touches the borrowed grant, so
    // holding one alongside it is harmless. A `self-acquired` run has no such
    // separate credential, so "the grant this run acquired" and "the token
    // somebody handed us" are the same thing, and the rotation probe would
    // burn a live user's session.
    return {
      enabled: false,
      reason:
        "this run holds an access token supplied for ordinary operation; intrusive probes must not spend a borrowed grant. Supply a dedicated test account instead.",
    };
  }
  if (config.protectedToolName !== undefined && !config.expectedScopes?.length) {
    return {
      enabled: false,
      reason:
        "a step-up probe requires `expectedScopes` alongside `protectedToolName`, so the run knows what it is asserting",
    };
  }

  return {
    enabled: true,
    grantOrigin: config.grantOrigin,
    credentials: config.testCredentials ?? {},
    protectedToolName: config.protectedToolName,
    expectedScopes: config.expectedScopes,
    cleanup: config.cleanup ?? true,
    authorization: AUTHORIZATION,
  };
}

// ── Check definitions ───────────────────────────────────────────────────

const DCR_REGISTER: ClaudeCheckDefinition = {
  id: "claude.intrusive.dynamic-registration",
  title: "Dynamic client registration succeeds and is cleanable",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Dynamic client registration"),
  provenance: "wire",
  intrusiveness: "side-effecting",
  requiresCapabilities: ["intrusive-probes"],
};

const REFRESH_ROTATION: ClaudeCheckDefinition = {
  id: "claude.intrusive.refresh-rotation",
  title: "A refresh token rotates and the old one is rejected",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Refresh tokens"),
  provenance: "wire",
  intrusiveness: "side-effecting",
  requiresCapabilities: ["intrusive-probes"],
};

const STEP_UP: ClaudeCheckDefinition = {
  id: "claude.intrusive.step-up-challenge",
  title: "A protected tool challenges for the scopes it needs",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("authentication", "§Step-up authorization"),
  provenance: "wire",
  intrusiveness: "side-effecting",
  requiresCapabilities: ["intrusive-probes"],
};

const INTRUSIVE_DEFINITIONS = [DCR_REGISTER, REFRESH_ROTATION, STEP_UP];

// ── Observations ────────────────────────────────────────────────────────

/**
 * What a probe SAW. The probes below produce these; the grading is separate,
 * so a caller who ran the probes elsewhere (the oauth-conformance session, for
 * instance) can hand its evidence straight in rather than re-registering.
 */
export interface ClaudeIntrusiveObservations {
  registration?: {
    attempted: boolean;
    status: number;
    /** RFC 7592 management URI, when the server issued one. */
    registrationClientUri?: string;
    /** Whether cleanup ran, and whether it worked. */
    cleanedUp?: boolean;
    cleanupError?: string;
    error?: string;
  };
  refresh?: {
    attempted: boolean;
    /** The server issued a NEW refresh token on the refresh. */
    rotated: boolean;
    /**
     * What the FIRST refresh request returned.
     *
     * Load-bearing for grading: a refresh that was rejected outright — a
     * confidential client probed without its secret answers `401
     * invalid_client` — issues no new token either, and is indistinguishable
     * from a non-rotating server unless the status is kept. One is the
     * server's defect; the other is the probe's own request being wrong.
     */
    refreshStatus?: number;
    refreshError?: string;
    /** Replaying the old refresh token: what came back. */
    replayStatus?: number;
    replayError?: string;
    /** Extra fields alongside `error` are valid and must not fail the check. */
    replayBody?: Record<string, unknown>;
    error?: string;
  };
  stepUp?: {
    attempted: boolean;
    toolName: string;
    status: number;
    wwwAuthenticate?: string;
    error?: string;
  };
}

/**
 * The scopes a step-up challenge asked for, beside the ones the run expected.
 *
 * Reported, never graded. A challenge that names no `scope` is conforming, and
 * a server is free to ask for scopes the operator did not list — so the useful
 * output is the comparison itself, which tells whoever reads the report
 * whether their declared expectation matched reality.
 */
function summarizeStepUpScopes(
  wwwAuthenticate: string | undefined,
  expectedScopes: string[] | undefined,
): Record<string, unknown> {
  const expected = expectedScopes ?? [];
  const challengedScopes = wwwAuthenticate
    ? (parseBearerAuthenticateParameters(wwwAuthenticate).scope ?? "")
        .split(/\s+/)
        .filter(Boolean)
    : [];
  return {
    expectedScopes: expected,
    challengedScopes,
    // `undefined` rather than a boolean when the challenge named nothing:
    // there is no overlap to report, and `false` would read as a mismatch the
    // server never committed.
    scopesOverlapExpectation:
      challengedScopes.length === 0
        ? undefined
        : challengedScopes.some((scope) => expected.includes(scope)),
  };
}

/**
 * Whether the refresh request itself was answered successfully.
 *
 * An older observation carries no `refreshStatus` — it predates the field —
 * and the honest reading of "no status recorded" is that the request is not
 * known to have failed, which keeps grading of previously captured evidence
 * exactly as it was.
 */
function refreshRequestSucceeded(
  refresh: NonNullable<ClaudeIntrusiveObservations["refresh"]>,
): boolean {
  if (refresh.refreshStatus === undefined) return true;
  return refresh.refreshStatus >= 200 && refresh.refreshStatus < 300;
}

/**
 * Grade what the probes saw.
 *
 * Kept apart from the probing so evidence from an existing oauth-conformance
 * session can be graded WITHOUT re-registering a client — the plan's
 * "reuse existing session evidence instead of auto re-registering" is a
 * property of this split, not a promise in a comment.
 */
export function gradeClaudeIntrusiveObservations(
  mode: ClaudeIntrusiveMode,
  observations: ClaudeIntrusiveObservations,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  if (!mode.enabled) {
    return INTRUSIVE_DEFINITIONS.map((definition) =>
      notEvaluated(definition, stamp, mode.reason, {
        missingInput: "intrusive",
      }),
    );
  }

  const findings: ClaudeReadinessFinding[] = [];

  // ── Dynamic client registration ──────────────────────────────────────
  const registration = observations.registration;
  if (!registration?.attempted) {
    findings.push(
      notEvaluated(
        DCR_REGISTER,
        stamp,
        registration?.error ??
          "no registration was attempted; the authorization server advertised no registration endpoint",
      ),
    );
  } else if (registration.status < 200 || registration.status >= 300) {
    findings.push(
      violated(
        DCR_REGISTER,
        stamp,
        "Dynamic client registration failed. Claude registers a client the first time a user connects, so this blocks every new connection.",
        { status: registration.status, error: registration.error },
      ),
    );
  } else if (registration.cleanedUp === false) {
    // A registration we could not remove is a client left behind on someone
    // else's server. Reporting it is the minimum; hiding it would make this
    // tool a slow leak.
    findings.push(
      violated(
        DCR_REGISTER,
        stamp,
        `Registration succeeded but the test client could not be removed${
          registration.registrationClientUri
            ? ` via ${registration.registrationClientUri}`
            : " (the server issued no `registration_client_uri`)"
        }. Delete it manually.`,
        {
          registrationClientUri: registration.registrationClientUri,
          cleanupError: registration.cleanupError,
        },
      ),
    );
  } else {
    findings.push(
      satisfied(DCR_REGISTER, stamp, {
        status: registration.status,
        cleanedUp: registration.cleanedUp ?? true,
      }),
    );
  }

  // ── Refresh rotation and replay ──────────────────────────────────────
  const refresh = observations.refresh;
  if (!refresh?.attempted) {
    findings.push(
      notEvaluated(
        REFRESH_ROTATION,
        stamp,
        refresh?.error ??
          "no refresh token was available from a grant this run owns, and a borrowed one must never be spent here",
      ),
    );
  } else if (!refresh.rotated && !refreshRequestSucceeded(refresh)) {
    // THE PROBE'S OWN REQUEST FAILED, so the server was never asked the
    // question this check grades. Calling that a rotation defect accuses a
    // submitter of a bug we manufactured — a confidential client probed
    // without its secret answers `401 invalid_client` and issues no token, and
    // so does a server with nothing wrong with it.
    findings.push(
      notEvaluated(
        REFRESH_ROTATION,
        stamp,
        `the refresh request was rejected (HTTP ${refresh.refreshStatus ?? "unknown"}${
          refresh.refreshError ? `, ${refresh.refreshError}` : ""
        }), so rotation was never exercised; check the credentials handed to the probe`,
      ),
    );
  } else if (!refresh.rotated) {
    findings.push(
      violated(
        REFRESH_ROTATION,
        stamp,
        "The refresh did not issue a new refresh token. Claude expects rotation; a static refresh token stays valid after a leak.",
        { refreshStatus: refresh.refreshStatus, replayStatus: refresh.replayStatus },
      ),
    );
  } else {
    // THE EXACT CONTRACT: HTTP 400 with `error: "invalid_grant"`. Extra fields
    // beside it are valid — `error_description`, `error_uri`, anything the
    // server wants — and a check that required an exact body would fail
    // conforming servers for being informative.
    const correctStatus = refresh.replayStatus === 400;
    const correctError = refresh.replayError === "invalid_grant";
    findings.push(
      correctStatus && correctError
        ? satisfied(REFRESH_ROTATION, stamp, {
            rotated: true,
            replayStatus: refresh.replayStatus,
            replayError: refresh.replayError,
            extraFields: Object.keys(refresh.replayBody ?? {}).filter(
              (key) => key !== "error",
            ),
          })
        : violated(
            REFRESH_ROTATION,
            stamp,
            `Replaying the rotated-out refresh token must answer HTTP 400 with \`error: "invalid_grant"\`; this answered ${refresh.replayStatus} with \`${refresh.replayError ?? "no error code"}\`.`,
            {
              replayStatus: refresh.replayStatus,
              replayError: refresh.replayError,
            },
          ),
    );
  }

  // ── Step-up ──────────────────────────────────────────────────────────
  const stepUp = observations.stepUp;
  if (!mode.protectedToolName) {
    findings.push(
      notEvaluated(
        STEP_UP,
        stamp,
        "no `protectedToolName` was declared; calling an arbitrary tool to see what happens is not something this runner does",
        { missingInput: "intrusive.protectedToolName" },
      ),
    );
  } else if (!stepUp?.attempted) {
    findings.push(
      notEvaluated(STEP_UP, stamp, stepUp?.error ?? "the step-up probe did not run"),
    );
  } else {
    const challenged =
      stepUp.status === 403 &&
      /insufficient_scope/.test(stepUp.wwwAuthenticate ?? "");
    // WHAT THE CONFIG PROMISED, MEASURED. `expectedScopes` is required
    // alongside `protectedToolName` so the run states what it is asserting,
    // but nothing compared it, so the requirement bought a config error and no
    // evidence. Recorded rather than graded: the `scope` parameter is OPTIONAL
    // on an `insufficient_scope` challenge — Claude selects scopes from
    // discovery when it is absent — so a server that omits it, or names its
    // own, is not thereby wrong.
    const scopeEvidence = summarizeStepUpScopes(
      stepUp.wwwAuthenticate,
      mode.expectedScopes,
    );
    findings.push(
      challenged
        ? satisfied(STEP_UP, stamp, {
            toolName: stepUp.toolName,
            wwwAuthenticate: stepUp.wwwAuthenticate,
            ...scopeEvidence,
          })
        : violated(
            STEP_UP,
            stamp,
            `Calling \`${stepUp.toolName}\` without its scopes answered ${stepUp.status}. Claude needs a 403 with \`error="insufficient_scope"\` to know it should re-authorize rather than give up.`,
            {
              status: stepUp.status,
              wwwAuthenticate: stepUp.wwwAuthenticate,
              ...scopeEvidence,
            },
          ),
    );
  }

  return findings;
}

// ── The probes ──────────────────────────────────────────────────────────

export interface ClaudeIntrusiveProbeOptions {
  fetchFn: typeof fetch;
  registrationEndpoint?: string;
  tokenEndpoint?: string;
  /** Redirect URIs to register. Claude's own, so the registration is realistic. */
  redirectUris: string[];
  timeoutMs?: number;
}

/**
 * Register a throwaway client and delete it again.
 *
 * The `authorization` parameter is the armed mode itself: the probe cannot be
 * called without one, and one cannot be built outside
 * {@link resolveClaudeIntrusiveMode}.
 */
export async function probeDynamicRegistration(
  mode: Extract<ClaudeIntrusiveMode, { enabled: true }>,
  options: ClaudeIntrusiveProbeOptions,
): Promise<NonNullable<ClaudeIntrusiveObservations["registration"]>> {
  assertArmed(mode);
  if (!options.registrationEndpoint) {
    return {
      attempted: false,
      status: 0,
      error: "the authorization server advertises no registration endpoint",
    };
  }

  const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await options.fetchFn(options.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        client_name: "MCPJam Claude readiness probe",
        redirect_uris: options.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
  } catch (error) {
    return {
      attempted: true,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const registrationClientUri =
    typeof body.registration_client_uri === "string"
      ? body.registration_client_uri
      : undefined;
  const registrationAccessToken =
    typeof body.registration_access_token === "string"
      ? body.registration_access_token
      : undefined;

  if (!response.ok) {
    return {
      attempted: true,
      status: response.status,
      error: typeof body.error === "string" ? body.error : response.statusText,
    };
  }

  if (!mode.cleanup) {
    return { attempted: true, status: response.status, registrationClientUri };
  }

  // RFC 7592 delete. A server that issued no management URI gives us no way to
  // clean up, and that is reported as a failure of THIS check rather than
  // quietly leaving a client behind.
  if (!registrationClientUri) {
    return {
      attempted: true,
      status: response.status,
      cleanedUp: false,
      cleanupError: "the server issued no `registration_client_uri`",
    };
  }

  try {
    const deleted = await options.fetchFn(registrationClientUri, {
      method: "DELETE",
      headers: registrationAccessToken
        ? { authorization: `Bearer ${registrationAccessToken}` }
        : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    return {
      attempted: true,
      status: response.status,
      registrationClientUri,
      cleanedUp: deleted.ok || deleted.status === 204,
      cleanupError: deleted.ok ? undefined : `DELETE answered ${deleted.status}`,
    };
  } catch (error) {
    return {
      attempted: true,
      status: response.status,
      registrationClientUri,
      cleanedUp: false,
      cleanupError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Spend a refresh token, then deliberately replay the spent one.
 *
 * ONLY ever reached with a grant the caller owns — the resolver refuses a
 * borrowed one, so by the time this runs, burning the token cannot log a real
 * user out of anything.
 */
export async function probeRefreshRotation(
  mode: Extract<ClaudeIntrusiveMode, { enabled: true }>,
  options: ClaudeIntrusiveProbeOptions,
): Promise<NonNullable<ClaudeIntrusiveObservations["refresh"]>> {
  assertArmed(mode);
  const refreshToken = mode.credentials.refreshToken;
  if (!options.tokenEndpoint || !refreshToken) {
    return {
      attempted: false,
      rotated: false,
      error: !options.tokenEndpoint
        ? "the authorization server advertises no token endpoint"
        : "no refresh token from a grant this run owns was supplied",
    };
  }

  const post = async (token: string) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
    });
    if (mode.credentials.clientId) body.set("client_id", mode.credentials.clientId);
    if (mode.credentials.clientSecret) {
      body.set("client_secret", mode.credentials.clientSecret);
    }
    const response = await options.fetchFn(options.tokenEndpoint!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { response, json };
  };

  let first: Awaited<ReturnType<typeof post>>;
  try {
    first = await post(refreshToken);
  } catch (error) {
    return {
      attempted: true,
      rotated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const refreshStatus = first.response.status;
  const refreshError =
    typeof first.json.error === "string" ? first.json.error : undefined;
  const issued =
    typeof first.json.refresh_token === "string"
      ? first.json.refresh_token
      : undefined;
  const rotated = issued !== undefined && issued !== refreshToken;
  if (!rotated) {
    // Carry the status out. Grading cannot tell "this server does not rotate"
    // from "the server refused OUR request" without it, and the difference
    // decides whether the finding is the submitter's to fix.
    return { attempted: true, rotated: false, refreshStatus, refreshError };
  }

  try {
    const replay = await post(refreshToken);
    return {
      attempted: true,
      rotated: true,
      replayStatus: replay.response.status,
      replayError:
        typeof replay.json.error === "string" ? replay.json.error : undefined,
      replayBody: replay.json,
    };
  } catch (error) {
    return {
      attempted: true,
      rotated: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
