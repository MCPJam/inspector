/**
 * The Claude gather half: the only Claude-readiness code that dials anything.
 *
 * WHY IT EXISTS SEPARATELY FROM `runner.ts`. `runClaudeReadiness` takes
 * gathered evidence and is pure — same evidence in, same result out — which is
 * what lets a test drive the whole grader from a fixture and what makes it
 * structurally impossible for a check to reach `169.254.169.254`. But nothing
 * ASSEMBLED that evidence: every caller wired the redirect trace, the auth
 * discovery and the tool listing together by hand, and each one did it slightly
 * differently. Three callers means three chances to forget the dial that
 * populates a lane, and a forgotten dial is invisible — it renders as
 * `not-evaluated`, which looks like a legitimate coverage gap.
 *
 * SYMMETRICAL WITH `gatherOpenAIReadinessEvidence` on purpose. The two
 * publishers grade completely different things and the shape of the work is
 * identical: gather once, serialize, grade anywhere. A hosted node can gather
 * on one machine and grade on another only if the evidence object survives
 * `JSON.stringify`, so nothing here returns a client handle or a stream.
 *
 * `fetchFn` IS REQUIRED, with no default. In a hosted run it must be the
 * DNS-pinned transport, and a default would make the unguarded case the easy
 * one to reach.
 *
 * WHAT THIS DOES NOT DO: call a model. Observations are billed, provider
 * credentials never reach a Node worker, and a gatherer that could spend money
 * would put spending inside the function every local run calls for free. The
 * caller validates an envelope and passes it in.
 *
 * Node entry only — exported from `sdk/src/index.ts`, never from `browser.ts`.
 */

import { resolveMcpHeaders } from "../directory-readiness/discovery.js";
import {
  DIRECTORY_DIAL_PROTOCOL_VERSION,
  dialMcpServer,
  type DirectoryDialOptions,
  type DirectoryResourceEvidence,
  type DirectoryToolEvidence,
} from "../directory-readiness/mcp-dial.js";
import {
  lazyAuthRediscoveryTrigger,
  normalizeFeatureClaims,
  refusedLazyAuthProbe,
  resolveLazyAuthProbeMode,
  type DirectoryLazyAuthProbeConfig,
  type DirectoryLazyAuthProbeEvidence,
} from "../directory-readiness/lazy-auth.js";
import { probeLazyAuthentication } from "../directory-readiness/lazy-auth-probe.js";
import {
  claudeAppResourceEvidenceFrom,
  claudeAppToolEvidenceFrom,
  type ClaudeAppResourceEvidence,
  type ClaudeAppsEvidence,
  type ClaudeAppToolEvidence,
} from "./checks/apps.js";
import type { ClaudeAuthEvidence } from "./checks/auth.js";
import {
  discoverClaudeAuthEvidence,
  discoverClaudeAuthMetadata,
  traceConnectorRedirects,
  type ClaudeDiscoveryOptions,
} from "./discovery.js";
import { CLAUDE_APP_HTML_MIME } from "./profile.js";
import type { ClaudeReadinessInput } from "./runner.js";
import {
  probeStepUpChallenge,
  resolveClaudeIntrusiveMode,
  type ClaudeIntrusiveConfig,
  type ClaudeIntrusiveObservations,
} from "./intrusive.js";
import type { ClaudeObservationState } from "./observations.js";
import type {
  ClaudeReadinessAuthMode,
  ClaudeRunnerCapability,
} from "./types.js";

export interface GatherClaudeReadinessEvidenceOptions
  extends Omit<DirectoryDialOptions, "enteredUrl" | "fetchFn"> {
  /** The connector URL exactly as the user entered it. Never canonicalized. */
  enteredUrl: string;
  /**
   * The transport, REQUIRED to gather any wire evidence.
   *
   * Without it the gatherer dials nothing and every wire lane reports its gap
   * — the honest outcome for a run assembled entirely from adapted evidence.
   */
  fetchFn?: typeof fetch;
  /**
   * The caller's cancellation.
   *
   * Composed into every request this gather makes, so a cancelled run stops
   * the request IN FLIGHT rather than merely declining to start the next one.
   * A readiness run's requests are seconds long against somebody else's
   * server, and that traffic is exactly what a cancellation is meant to stop.
   */
  signal?: AbortSignal;
  authMode?: ClaudeReadinessAuthMode;
  capabilities?: ClaudeRunnerCapability[];

  /**
   * Apps evidence the caller already holds, typically adapted from an
   * attributable apps-conformance run.
   *
   * Supplying it SKIPS the app-resource dial: an attributable result is
   * already a statement about this server, and re-reading the resources would
   * let two readings of one server disagree.
   */
  apps?: ClaudeAppsEvidence;
  /** A tool listing the caller already holds. Supplying it skips the dial. */
  tools?: DirectoryToolEvidence[];

  submissionProfile?: unknown;
  /**
   * Features the submitter claims: the grader's own record shape, or the
   * claim names every surface sends (`"lazy-authentication"`,
   * `"enterprise-managed-auth"`). Unknown names are ignored here; surfaces
   * refuse them before they arrive.
   */
  claimedFeatures?: ClaudeReadinessInput["claimedFeatures"] | readonly string[];
  observedAuthMode?: string;
  /**
   * Arm the lazy-auth probe: at most two unauthenticated calls to read-only
   * tools — one public, one protected — in a session of the probe's own.
   *
   * It sends NO credentials, whatever `mcpHeaders` holds. When the protected
   * call is refused with a 401, Protected Resource Metadata and the first
   * authorization server are discovered again from THAT challenge — the
   * request Claude would follow — and the auth lanes are graded on what it
   * finds.
   */
  lazyAuthProbe?: DirectoryLazyAuthProbeConfig;
  /** Authorization requests only the caller that drove the flow can have seen. */
  authExtras?: Parameters<typeof discoverClaudeAuthEvidence>[1];

  intrusive?: ClaudeIntrusiveConfig;
  intrusiveObservations?: ClaudeIntrusiveObservations;

  /**
   * An ALREADY VALIDATED observation state. Never a raw provider response, and
   * never a reason for this function to call a provider — see the docblock.
   */
  llmObservations?: ClaudeObservationState;

  evidenceSources?: string[];
  /**
   * Injected so the gatherer is deterministic under test. Not a convenience: a
   * gatherer that read the clock itself would make every evidence object
   * unequal to every other, and the point of a serializable evidence object is
   * that two runs over the same inputs produce the same one.
   */
  now?: () => Date;
}

/** Claim names, or the record, into the record the grader reads. */
function claudeClaimedFeatures(
  value: GatherClaudeReadinessEvidenceOptions["claimedFeatures"],
): ClaudeReadinessInput["claimedFeatures"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return value as ClaudeReadinessInput["claimedFeatures"];
  }
  const { claims } = normalizeFeatureClaims(value);
  return {
    ...(claims.includes("lazy-authentication")
      ? { lazyAuthentication: true }
      : {}),
    ...(claims.includes("enterprise-managed-auth")
      ? { enterpriseManagedAuth: true }
      : {}),
  };
}

/** Read one dialled resource into the shape the apps checks grade. */
function appResourceFrom(
  resource: DirectoryResourceEvidence,
): ClaudeAppResourceEvidence {
  // `html` is deliberately absent. The listing describes a resource; it does
  // not serve one, and the design lints that read `html` must stay
  // `not-evaluated` rather than grade a body nobody fetched. A caller that
  // wants them runs the apps suite and adapts its result.
  const adapted = claudeAppResourceEvidenceFrom({
    uri: resource.uri,
    mimeType: resource.mimeType,
    _meta: resource._meta,
  });
  return adapted ?? { uri: resource.uri, mimeType: resource.mimeType };
}

/**
 * Gather everything a Claude readiness grade needs.
 *
 * The dial is skipped for whichever pieces the caller already holds, and the
 * order is causal rather than parallel: the auth discovery follows a challenge
 * the endpoint publishes, and the app-resource read needs the session the
 * initialize opened.
 */
export async function gatherClaudeReadinessEvidence(
  options: GatherClaudeReadinessEvidenceOptions,
): Promise<ClaudeReadinessInput> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const discovery: ClaudeDiscoveryOptions | undefined = options.fetchFn
    ? {
        enteredUrl: options.enteredUrl,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        maxRedirects: options.maxRedirects,
        mcpHeaders: resolveMcpHeaders(options),
        signal: options.signal,
      }
    : undefined;

  const [endpoint, initialAuth] = discovery
    ? await Promise.all([
        traceConnectorRedirects(discovery),
        discoverClaudeAuthEvidence(discovery, options.authExtras),
      ])
    : [
        { enteredUrl: options.enteredUrl },
        { enteredUrl: options.enteredUrl } as ClaudeAuthEvidence,
      ];
  let auth: ClaudeAuthEvidence = initialAuth;

  // THE DIAL. Skipped entirely when the caller supplied both halves, because
  // then there is nothing left for it to establish.
  // AN EXPLICIT EMPTY ARRAY IS A SUPPLIED LISTING — `!options.tools` is truthy
  // for `[]`, which would dial over the top of a caller that had already
  // established this server advertises no tools, and then attach the dial's
  // completeness to their answer.
  const hasSuppliedTools = options.tools !== undefined;
  const hasSuppliedApps = options.apps !== undefined;
  const needsDial =
    discovery !== undefined && (!hasSuppliedTools || !hasSuppliedApps);
  const dialled = needsDial
    ? await dialMcpServer({
        ...discovery!,
        // Requested only when its answer will be USED. Walking the resource
        // listing for a caller who already holds an attributable apps result
        // is a page of requests aimed at somebody else's server for evidence
        // this run is about to discard.
        appHtmlMime: hasSuppliedApps ? undefined : CLAUDE_APP_HTML_MIME,
        ...(hasSuppliedTools ? { tools: options.tools } : {}),
        maxListPages: options.maxListPages,
        maxListEntries: options.maxListEntries,
      })
    : undefined;

  const tools = hasSuppliedTools ? options.tools : dialled?.tools?.entries;

  // WHETHER THE APPS LANE MAY BE GRADED AT ALL. `appsSuiteRan` is not "we saw
  // some resources" — it is "this run holds an attributable statement about
  // this server's widgets". A caller-supplied `apps` (an adapted conformance
  // result) is one. A resource listing this run dialled is one too, but only
  // when it FINISHED: a truncated listing would let a server's non-conforming
  // widget fall off the end and read as a server with no widgets, which grades
  // `not-applicable` — a clean bill of health for a page nobody read.
  //
  // BOTH LISTINGS HAVE TO HAVE FINISHED, because the apps checks read both. A
  // truncated TOOL listing is the same hazard wearing the other hat: the
  // widget tool that fell off the end takes its `_meta` with it, and a lane
  // that saw no widget tools reports `not-applicable` over a page nobody
  // finished reading. The tools lane reporting its own gap does not repair
  // this one — they are different claims, and only one of them was hedged.
  const dialledApps = dialled?.appResources;
  const toolListingUsable = hasSuppliedTools || dialled?.tools?.complete === true;
  const appsFromDial: ClaudeAppsEvidence | undefined =
    dialledApps && dialledApps.listing.complete && toolListingUsable
      ? {
          enteredUrl: options.enteredUrl,
          appsSuiteRan: true,
          tools: (tools ?? [])
            .map((tool) => claudeAppToolEvidenceFrom(tool))
            .filter(
              (evidence): evidence is ClaudeAppToolEvidence =>
                evidence !== undefined,
            ),
          resources: dialledApps.appResources.map(appResourceFrom),
        }
      : undefined;

  // ── The lazy-auth probe ──────────────────────────────────────────────
  // After the dial, so a named tool an anonymous session cannot see can
  // still be found in the listing the dial already holds. A probe that was
  // requested and refused by its gate is recorded with the reason.
  let lazyAuthProbe: DirectoryLazyAuthProbeEvidence | undefined;
  if (options.lazyAuthProbe !== undefined && discovery) {
    const mode = resolveLazyAuthProbeMode(options.lazyAuthProbe);
    if (!mode.enabled) {
      lazyAuthProbe = refusedLazyAuthProbe(
        mode.reason,
        DIRECTORY_DIAL_PROTOCOL_VERSION,
      );
    } else {
      lazyAuthProbe = await probeLazyAuthentication({
        // Field by field: the probe must never see `mcpHeaders`.
        enteredUrl: discovery.enteredUrl,
        fetchFn: discovery.fetchFn,
        timeoutMs: discovery.timeoutMs,
        signal: discovery.signal,
        mode,
        knownTools: tools,
      });
      // RE-DISCOVER FROM THE 401, and only the 401: Claude follows an HTTP
      // challenge and nothing else, so metadata named only in a tool result's
      // `_meta` is metadata Claude never finds.
      const trigger = lazyAuthRediscoveryTrigger(lazyAuthProbe.protectedCall, [
        "http_401",
      ]);
      if (trigger) {
        const rediscovered = await discoverClaudeAuthMetadata(
          discovery,
          trigger.pointer,
        );
        auth = { ...auth, ...rediscovered };
        lazyAuthProbe.rediscovery = {
          trigger: trigger.trigger,
          source: trigger.source,
          prmFound: rediscovered.prm?.discoveredVia !== "not-found",
          ...(rediscovered.prm?.url ? { prmUrl: rediscovered.prm.url } : {}),
          ...(rediscovered.prm?.discoveredVia
            ? { discoveredVia: rediscovered.prm.discoveredVia }
            : {}),
        };
      }
    }
  }

  // ── The step-up probe ────────────────────────────────────────────────
  // Only for an ARMED intrusive mode that declared its tool, and only when
  // the caller did not already hand the observation in. It uses the run's own
  // credential — the caller's token, which is the one that lacks the scope —
  // and the probe refuses a tool not annotated read-only.
  let intrusiveObservations = options.intrusiveObservations;
  const authMode = options.authMode ?? "headless";
  const intrusiveMode = resolveClaudeIntrusiveMode(options.intrusive, {
    hasBorrowedAccessToken: authMode === "provided-token",
  });
  if (
    intrusiveMode.enabled &&
    intrusiveMode.protectedToolName &&
    intrusiveObservations?.stepUp === undefined &&
    discovery
  ) {
    const stepUp = await probeStepUpChallenge(intrusiveMode, {
      enteredUrl: discovery.enteredUrl,
      fetchFn: discovery.fetchFn,
      timeoutMs: discovery.timeoutMs,
      signal: discovery.signal,
      mcpHeaders: discovery.mcpHeaders ?? {},
    });
    intrusiveObservations = { ...intrusiveObservations, stepUp };
  }

  const finishedAt = now();

  return {
    enteredUrl: options.enteredUrl,
    authMode: options.authMode ?? "headless",
    capabilities: options.capabilities ?? [],
    startedAt,
    evaluatedAt: finishedAt.toISOString(),
    durationMs: Math.max(
      0,
      finishedAt.getTime() - new Date(startedAt).getTime(),
    ),
    endpoint,
    auth,
    apps: options.apps ??
      appsFromDial ?? {
        enteredUrl: options.enteredUrl,
        appsSuiteRan: false,
      },
    tools: tools as ClaudeReadinessInput["tools"],
    toolListingComplete: hasSuppliedTools
      ? undefined
      : dialled?.tools?.complete,
    toolListingError: hasSuppliedTools ? undefined : dialled?.tools?.error,
    submissionProfile: options.submissionProfile,
    claimedFeatures: claudeClaimedFeatures(options.claimedFeatures),
    observedAuthMode: options.observedAuthMode,
    intrusive: options.intrusive,
    intrusiveObservations,
    ...(lazyAuthProbe ? { lazyAuthProbe } : {}),
    llmObservations: options.llmObservations,
    evidenceSources: options.evidenceSources,
  };
}
