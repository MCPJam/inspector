/**
 * The end-to-end readiness run: a URL in, a graded result out.
 *
 * This is the only module that both dials a target AND grades it, and it does
 * so by composing the two halves rather than merging them — evidence gathering
 * (`discovery.ts`, plus one MCP connection here) and grading
 * (`gradeClaudeReadiness`) stay separable, so a caller who already has
 * evidence can grade it without a socket, and every check module remains a
 * pure function that structurally cannot reach the network.
 *
 * WHAT IT DOES NOT DO. It does not run the conformance suites. An
 * `MCPAppsConformanceResult` is an INPUT: readiness composes that verdict
 * rather than re-deriving it, so the two can never disagree about the same
 * server. A caller that has one passes it; a caller that does not gets the
 * apps lane reported as unevaluated, which is the honest answer.
 *
 * Node-only: it opens a real MCP connection.
 */

import type { Tool } from "@modelcontextprotocol/client";

import type { HttpServerConfig } from "../mcp-client-manager/index.js";
import { listTools, withEphemeralClient } from "../operations.js";
import {
  claudeAppResourceEvidenceFrom,
  claudeAppToolEvidenceFrom,
  type ClaudeAppResourceEvidence,
  type ClaudeAppToolEvidence,
} from "./checks/apps.js";
import {
  discoverClaudeAuthEvidence,
  traceConnectorRedirects,
} from "./discovery.js";
import { gradeClaudeReadiness, type ClaudeReadinessInput } from "./runner.js";
import type {
  ClaudeIntrusiveConfig,
  ClaudeIntrusiveObservations,
} from "./intrusive.js";
import type {
  ClaudeReadinessAuthMode,
  ClaudeReadinessResult,
  ClaudeRunnerCapability,
} from "./types.js";

export interface ClaudeReadinessRunConfig {
  /** The connector URL exactly as the user entered it. Never canonicalized. */
  serverUrl: string;
  /**
   * The transport. REQUIRED, for the reason `discovery.ts` states: a default
   * would make "forgot to pass the guard" the silent case, and the silent case
   * is the one that reaches a private address.
   */
  fetchFn: typeof fetch;
  /** Bearer token for a connector that needs one to list its tools. */
  accessToken?: string;
  customHeaders?: Record<string, string>;
  /** Per-request budget. The caller owns the run-level deadline. */
  timeoutMs?: number;

  /** Declared submission profile, raw — validated during grading. */
  submissionProfile?: unknown;
  claimedFeatures?: {
    lazyAuthentication?: boolean;
    enterpriseManagedAuth?: boolean;
  };

  /** Opt-in for the side-effecting probes. Off unless fully specified. */
  intrusive?: ClaudeIntrusiveConfig;
  /** Observations from probes the caller ran, e.g. an oauth-conformance session. */
  intrusiveObservations?: ClaudeIntrusiveObservations;

  /**
   * Whether an MCP Apps conformance result was obtained. Passing `false` (the
   * default) reports the apps lane unevaluated rather than claiming this
   * server has no widgets.
   */
  appsSuiteRan?: boolean;
  /** Suite results consumed as evidence, named for the report. */
  evidenceSources?: string[];

  /** What the executing surface can do. Recorded so coverage is legible. */
  capabilities?: ClaudeRunnerCapability[];

  /**
   * Stops the run from issuing anything further.
   *
   * A hosted run holds a lease; when that lease is cancelled or swept, the
   * point of stopping is the TARGET. A run that keeps probing after the person
   * who started it pressed cancel is still dialling somebody else's server,
   * and "we stopped waiting for the answer" is not the same as "we stopped
   * asking".
   *
   * Aborting produces a graded result rather than a throw wherever the stage
   * can report what it has: an aborted redirect trace is a short chain, an
   * aborted connection is no tool listing. The checks already know how to say
   * "not evaluated", which is the honest answer for a run that was stopped.
   */
  signal?: AbortSignal;
}

/**
 * How many widget resources one run will read, and how long it will spend.
 *
 * The URI list comes from the TARGET's tool metadata, so its length is the
 * target's choice: a server advertising four hundred unreadable widgets would
 * otherwise cost four hundred times the per-request timeout, in a command
 * someone put in CI. Both bounds are generous next to any real connector —
 * a widget per tool, and thirty seconds to fetch a page of HTML.
 */
const MAX_WIDGET_RESOURCE_READS = 25;
const WIDGET_RESOURCE_BUDGET_MS = 30_000;

/**
 * Reject once the budget is spent, whatever the underlying call is doing.
 *
 * `readResource` takes its timeout from the connection, which is per REQUEST;
 * this bounds the phase. The pending read is abandoned rather than cancelled —
 * the connection is torn down with the ephemeral client moments later.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("widget resource read budget exhausted")),
        ms
      );
      // Never hold the process open for a timer whose race already settled.
      timer.unref?.();
    }),
  ]);
}

/** What one MCP connection yielded, or why it yielded nothing. */
interface ConnectionEvidence {
  tools?: Tool[];
  appTools: ClaudeAppToolEvidence[];
  appResources: ClaudeAppResourceEvidence[];
  connected: boolean;
  /**
   * Widget URIs the run did not get to, because the read budget ran out.
   *
   * Carried rather than dropped: fewer resources means fewer design findings,
   * and a lane that silently grades less than it was asked to is the failure
   * every check module here is written to avoid.
   */
  unreadResourceUris: string[];
}

/**
 * Connect once and read what the checks need: the tool list, and the widget
 * resources those tools point at.
 *
 * A failure is NOT thrown. A connector that cannot be connected to is a real
 * finding, and the endpoint and auth lanes describe it far better than a stack
 * trace would — so the run continues and grades what it has.
 */
async function gatherFromConnection(
  config: ClaudeReadinessRunConfig
): Promise<ConnectionEvidence> {
  const serverConfig: HttpServerConfig = {
    url: config.serverUrl,
    accessToken: config.accessToken,
    requestInit: config.customHeaders
      ? { headers: config.customHeaders }
      : undefined,
    timeout: config.timeoutMs,
    // The SAME guard the probes use, threaded into the transport itself.
    baseFetch: config.fetchFn,
  };

  try {
    return await withEphemeralClient(
      serverConfig,
      async (manager, serverId) => {
        const { tools } = await listTools(manager, { serverId });
        const appTools = tools
          .map((tool) => claudeAppToolEvidenceFrom(tool))
          .filter(
            (entry): entry is ClaudeAppToolEvidence => entry !== undefined
          );

        const appResources: ClaudeAppResourceEvidence[] = [];
        // Only the URIs the tools actually reference, and each one once: a
        // widget referenced by three tools is one resource to read.
        const uris = [
          ...new Set(
            appTools
              .map((tool) => tool.resourceUri)
              .filter((uri) => uri.length > 0)
          ),
        ];
        const unreadResourceUris: string[] = [];
        const readsDeadline = Date.now() + WIDGET_RESOURCE_BUDGET_MS;
        for (const [index, uri] of uris.entries()) {
          const remainingMs = readsDeadline - Date.now();
          if (index >= MAX_WIDGET_RESOURCE_READS || remainingMs <= 0) {
            unreadResourceUris.push(uri);
            continue;
          }
          try {
            // BOUNDED BY WHAT IS LEFT, not by the per-request timeout. Checking
            // the deadline only before the call let a read that started one
            // millisecond inside the budget run for a whole `timeoutMs` past
            // it, which is a budget the last resource always gets to overrun.
            const contents = await withTimeout(
              manager.readResource(serverId, { uri }),
              remainingMs
            );
            for (const content of contents.contents ?? []) {
              appResources.push(
                claudeAppResourceEvidenceFrom({
                  uri: content.uri ?? uri,
                  mimeType: content.mimeType,
                  // A blob content has no `text`, and the design lints want
                  // markup — reading a base64 payload as HTML would produce
                  // confident nonsense, so it is simply absent.
                  text: "text" in content ? content.text : undefined,
                  _meta: content._meta,
                })
              );
            }
          } catch {
            // UNREAD IS UNREAD, whether the budget ran out or the server
            // refused: dropping the URI here made the coverage finding report
            // a complete pass over a widget nobody managed to look at.
            unreadResourceUris.push(uri);
            // Not fatal. A widget resource that cannot be read is graded by
            // the apps suite, whose verdict this run composes, and failing the
            // whole run over it would lose every other lane.
          }
        }

        return {
          tools,
          appTools,
          appResources,
          connected: true,
          unreadResourceUris,
        };
      },
      {
        timeout: config.timeoutMs ?? 30_000,
        clientName: "mcpjam-claude-readiness",
      }
    );
  } catch {
    // `tools: undefined` is load-bearing — it means "no listing was captured",
    // which the tool checks report as an untested obligation rather than as a
    // server with no tools.
    return {
      appTools: [],
      appResources: [],
      connected: false,
      unreadResourceUris: [],
    };
  }
}

/**
 * Run every non-invasive stage against a target and grade the result.
 *
 * `authMode` is derived rather than asked for: a run holding a caller-supplied
 * token is `provided-token`, which is also what makes the intrusive resolver
 * refuse to spend that token.
 */
export async function runClaudeReadiness(
  config: ClaudeReadinessRunConfig
): Promise<ClaudeReadinessResult> {
  const startedAt = new Date();
  const discoveryOptions = {
    enteredUrl: config.serverUrl,
    fetchFn: config.fetchFn,
    timeoutMs: config.timeoutMs,
    headers: config.customHeaders,
    signal: config.signal,
  };

  const endpoint = await traceConnectorRedirects(discoveryOptions);
  const auth = await discoverClaudeAuthEvidence(discoveryOptions);
  // Checked BETWEEN stages as well as inside them: opening an MCP connection
  // is the most expensive thing this run does to a third party, and a run that
  // was cancelled during discovery has no business starting one.
  const connection = config.signal?.aborted
    ? { appTools: [], appResources: [], connected: false, unreadResourceUris: [] }
    : await gatherFromConnection(config);

  const authMode: ClaudeReadinessAuthMode = config.accessToken
    ? "provided-token"
    : "headless";

  const input: ClaudeReadinessInput = {
    enteredUrl: config.serverUrl,
    authMode,
    capabilities: config.capabilities ?? ["dns"],
    startedAt: startedAt.toISOString(),
    // ONE moment for the whole run: findings from one run are one observation,
    // and a per-check clock would make them look like several.
    evaluatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    endpoint,
    auth,
    tools: connection.tools,
    apps: {
      enteredUrl: config.serverUrl,
      appsSuiteRan: config.appsSuiteRan ?? false,
      tools: connection.appTools,
      resources: connection.appResources,
      unreadResourceUris: connection.unreadResourceUris,
    },
    submissionProfile: config.submissionProfile,
    claimedFeatures: config.claimedFeatures,
    // Only ever used to CONTRADICT a declaration, never to supply one.
    observedAuthMode: describeObservedAuthMode(auth),
    intrusive: config.intrusive,
    intrusiveObservations: config.intrusiveObservations,
    evidenceSources: config.evidenceSources,
  };

  return gradeClaudeReadiness(input);
}

/**
 * The auth mode this run OBSERVED, in the submission profile's vocabulary, or
 * `undefined` when the wire did not settle it.
 *
 * `undefined` is the common answer and the safe one: a static-header connector
 * and an authless one look identical from outside, so guessing would fail a
 * truthful declaration.
 */
function describeObservedAuthMode(
  auth: Awaited<ReturnType<typeof discoverClaudeAuthEvidence>>
): string | undefined {
  const document = auth.firstAuthorizationServer?.document;
  if (document?.registration_endpoint) return "oauth-dcr";
  if (document?.client_id_metadata_document_supported === true) {
    return "oauth-cimd";
  }
  if (auth.unauthenticated?.servedWithoutCredentials === true) {
    return "authless";
  }
  return undefined;
}
