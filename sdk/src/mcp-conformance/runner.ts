import {
  buildOutcomeSummary,
  decideConformanceOutcome,
  isUnrunCheck,
} from "../conformance-outcome.js";
import {
  buildConformanceProfileStamp,
  conformanceProfile,
  partitionByProfile,
} from "../conformance-profile.js";
import type { HttpServerConfig } from "../mcp-client-manager/index.js";
import { isKnownProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";
import {
  listPrompts,
  listResources,
  listTools,
  withEphemeralClient,
} from "../operations.js";
import { CORE_CHECKS } from "./checks/core.js";
import { RESOURCE_CHECKS } from "./checks/resources.js";
import { MODERN_CHECK_METADATA, runModernChecks } from "./checks/modern.js";
import { runProtocolChecks } from "./checks/protocol.js";
import { runSecurityChecks } from "./checks/security.js";
import { runTransportChecks } from "./checks/transport.js";
import { runWireSchemaCheck, WIRE_SCHEMA_CHECK_ID } from "./checks/wire.js";
import { TOOL_CHECKS } from "./checks/tools.js";
import { PROMPT_CHECKS } from "./checks/prompts.js";
import {
  errorMessage,
  eraSkipMessage,
  failedResult,
  couldNotRunResult,
  notApplicableResult,
} from "./checks/helpers.js";
import type {
  MCPCheckCategory,
  MCPCheckEra,
  MCPCheckId,
  MCPCheckResult,
  MCPClientCheckContext,
  MCPClientCheckDefinition,
  MCPConformanceConfig,
  MCPConformanceResult,
  MCPReadinessWarning,
  MCPServerSurfaceSnapshot,
  NormalizedMCPConformanceConfig,
  RawHttpCheckContext,
} from "./types.js";
import { CHECK_ERAS, MCP_CHECK_CATEGORIES } from "./types.js";
import {
  collectClientReadiness,
  collectRawReadiness,
} from "./readiness.js";
import { WireObservationRecorder } from "./wire-observations.js";
import { createCapturingFetch } from "./raw-capture.js";
import {
  eraForProtocolVersion,
  normalizeMCPConformanceConfig,
} from "./validation.js";

const CLIENT_CHECKS = [
  ...CORE_CHECKS,
  ...TOOL_CHECKS,
  ...PROMPT_CHECKS,
  ...RESOURCE_CHECKS,
] as const;

const RAW_CHECK_CATEGORY_ENTRIES: ReadonlyArray<
  readonly [MCPCheckId, MCPCheckCategory]
> = [
  ["protocol-invalid-method-error", "protocol"],
  ["localhost-host-rebinding-rejected", "security"],
  ["localhost-host-valid-accepted", "security"],
  ["server-sse-polling-session", "transport"],
  ["server-accepts-multiple-post-streams", "transport"],
  ["server-sse-streams-functional", "transport"],
  ["notification-post-accepted", "transport"],
  ["get-stream-or-405", "transport"],
  ["session-id-visible-ascii", "transport"],
  ["post-response-content-type", "transport"],
  [WIRE_SCHEMA_CHECK_ID, "protocol"],
  ...Object.values(MODERN_CHECK_METADATA).map(
    (check): readonly [MCPCheckId, MCPCheckCategory] => [
      check.id,
      check.category,
    ],
  ),
];

const CHECK_CATEGORY_BY_ID = new Map<MCPCheckId, MCPCheckCategory>(
  [
    ...CLIENT_CHECKS.map(
      (check): readonly [MCPCheckId, MCPCheckCategory] => [
        check.id,
        check.category,
      ],
    ),
    ...RAW_CHECK_CATEGORY_ENTRIES,
  ],
);

function buildCheckSelection(
  config: NormalizedMCPConformanceConfig,
): Set<MCPCheckId> {
  if (config.checkIds?.length) {
    return new Set(config.checkIds);
  }

  return new Set(
    [...CHECK_CATEGORY_BY_ID.entries()]
      .filter(([, category]) => config.categories.includes(category))
      .map(([checkId]) => checkId),
  );
}

function summarizeChecks(checks: MCPCheckResult[]) {
  return Object.fromEntries(
    MCP_CHECK_CATEGORIES.map((category) => {
      const categoryChecks = checks.filter((check) => check.category === category);
      return [
        category,
        {
          total: categoryChecks.length,
          passed: categoryChecks.filter((check) => check.status === "passed").length,
          failed: categoryChecks.filter((check) => check.status === "failed").length,
          skipped: categoryChecks.filter((check) => check.status === "skipped").length,
          couldNotRun: categoryChecks.filter(isUnrunCheck).length,
        },
      ];
    }),
  ) as MCPConformanceResult["categorySummary"];
}

const buildSummary = buildOutcomeSummary;

function createServerConfig(
  config: NormalizedMCPConformanceConfig,
  recorder: WireObservationRecorder,
): HttpServerConfig {
  // The client's traffic is only visible UNNORMALIZED here: by the time a
  // result reaches app code the official Client has consumed the wire-only
  // members (`resultType`, the cache hints, the `_meta` envelope) that the
  // schema check exists to inspect. Wrapping its base fetch is the one seam
  // that sees them.
  //
  // No double-counting with the raw path: `rawRequest` builds its own
  // capturing fetch over `config.fetchFn` and records there, while this
  // wrapper sits on the Client's `baseFetch`. The two stacks never share an
  // exchange.
  const recordingFetch: typeof fetch = async (input, init) => {
    // ONE CAPTURE PER CALL. A single shared instance appends every exchange to
    // one array, and reading the last element after an `await` is only correct
    // while nothing else is in flight — which is never true here: the client
    // phase fans `tools/list`, `prompts/list`, `resources/list` and
    // `resources/templates/list` out through one `Promise.all`. Whichever
    // settles second would be recorded twice and the other not at all, and
    // since `recordExchange` derives the request method from the exchange it
    // was handed, a `tools/list` response would be graded against
    // `ListPromptsResult` — a fabricated violation in the one check whose
    // entire value is correlation.
    // NEVER BUFFER A STREAM THE SERVER MAY HOLD OPEN. The capturing fetch
    // reads the response body to completion before returning it — its own
    // docstring says it is "NOT suitable for wrapping a long-lived stream" —
    // and the official client opens a standing `GET` with
    // `accept: text/event-stream` through exactly this seam
    // (`_startOrAuthSse`). A conforming 2025-era server that holds that stream
    // open would never let the capture resolve, so the transport would never
    // receive its response and the run would hang against a server that did
    // nothing wrong. The same applies to a POST answered over SSE that the
    // server keeps open (closing it is only a SHOULD).
    //
    // `skipStreamBodies` records those head-only — status and headers, no body
    // — and hands the untouched stream to the transport. Nothing the graded
    // checks read is lost: every wire member they inspect (`resultType`, the
    // cache hints, the `_meta` envelope) rides the JSON responses, and the raw
    // track captures its own SSE frames at a seam that owns the stream's
    // lifetime.
    const capture = createCapturingFetch(config.fetchFn, {
      skipStreamBodies: true,
    });
    const response = await capture.fetch(input, init);
    for (const exchange of capture.exchanges) {
      recorder.recordExchange(exchange);
    }
    return response;
  };
  return {
    url: config.serverUrl,
    accessToken: config.accessToken,
    requestInit: config.customHeaders
      ? { headers: config.customHeaders }
      : undefined,
    timeout: config.checkTimeout,
    // Flows through the negotiation resolver: a modern (stateless) pin makes
    // the underlying Client negotiate the 2026 era so a modern-only server can
    // connect at all. Absent ⇒ `auto` (automatic negotiation is always on), so
    // an unconfigured conformance run detects the era the server negotiates.
    mcpProtocolVersion: config.protocolVersion,
    // THE SAME GUARD THE RAW PROBES GET. `fetchFn` used to reach only the raw
    // HTTP/SSE probes, so the one real MCP connection this suite opens dialled
    // through the global fetch and followed its redirects unchecked — a
    // hosted-mode SSRF hole this file's own comment used to document. Threading
    // it in as the transport's base fetch closes it: one guard, one target, no
    // second resolution.
    baseFetch: recordingFetch,
  };
}

/**
 * Era gate for a client-backed check. Returns a `skipped` result (never
 * filtered out — the check still appears in the report) when the check does
 * not apply to the run's era per {@link CHECK_ERAS}, else `undefined` so the
 * check runs normally. Skipped checks never fail a run (the verdict is
 * `checks.every(c => c.status !== "failed")`).
 */
function eraGate(
  check: MCPClientCheckDefinition,
  era: MCPCheckEra,
  protocolVersion: string | undefined,
): MCPCheckResult | undefined {
  if (CHECK_ERAS[check.id].includes(era)) {
    return undefined;
  }
  return notApplicableResult(check, eraSkipMessage(era, protocolVersion));
}

async function safeListResourceTemplates(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
): Promise<string[]> {
  try {
    // Conformance is a raw-evidence surface: bypass the SEP-2549 response
    // cache so the check always exercises the live wire.
    const result = await ctx.manager.listResourceTemplates(
      ctx.serverId,
      undefined,
      { cacheMode: "bypass" },
    );
    return (result.resourceTemplates ?? []).map((template) => template.uriTemplate);
  } catch {
    return [];
  }
}

async function safeListTools(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
) {
  try {
    return await listTools(ctx.manager, { serverId: ctx.serverId });
  } catch {
    return {
      tools: [],
      nextCursor: undefined,
    };
  }
}

async function safeListPrompts(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
) {
  try {
    return await listPrompts(ctx.manager, { serverId: ctx.serverId });
  } catch {
    return {
      prompts: [],
      nextCursor: undefined,
    };
  }
}

async function safeListResources(
  ctx: Pick<MCPClientCheckContext, "manager" | "serverId">,
) {
  try {
    return await listResources(ctx.manager, { serverId: ctx.serverId });
  } catch {
    return {
      resources: [],
      nextCursor: undefined,
    };
  }
}

async function runClientChecks(
  config: NormalizedMCPConformanceConfig,
  selectedCheckIds: Set<MCPCheckId>,
  recorder: WireObservationRecorder,
): Promise<{
  checks: MCPCheckResult[];
  config: NormalizedMCPConformanceConfig;
  surface?: MCPServerSurfaceSnapshot;
  readiness: MCPReadinessWarning[];
}> {
  const selectedClientChecks = CLIENT_CHECKS.filter((check) =>
    selectedCheckIds.has(check.id),
  );

  // Explicit pins already carry their era into the raw runners. Auto mode
  // still needs one real MCP connection so raw-only protocol/security/
  // transport selections use the version the server actually negotiated.
  if (
    selectedClientChecks.length === 0 &&
    config.protocolVersion !== undefined
  ) {
    return { checks: [], config, readiness: [] };
  }

  try {
    return await withEphemeralClient(
      createServerConfig(config, recorder),
      async (manager, serverId) => {
        // `getManagedClient()` works for every era — the modern pin and the
        // legacy path both resolve to a `ManagedMcpClient` (the stateless
        // preview adapter was removed in Phase 1C; both go through the
        // official Client now). Absent only if connect failed to register a
        // client, which is a genuine error.
        const client = manager.getManagedClient(serverId);
        if (!client) {
          throw new Error("Managed MCP client is unavailable after connect");
        }

        const initializationInfo = manager.getInitializationInfo(serverId);
        const negotiatedProtocolVersion = initializationInfo?.protocolVersion;
        const effectiveConfig: NormalizedMCPConformanceConfig =
          config.protocolVersion === undefined &&
          negotiatedProtocolVersion !== undefined &&
          isKnownProtocolVersion(negotiatedProtocolVersion)
            ? {
                ...config,
                protocolVersion: negotiatedProtocolVersion,
                era: eraForProtocolVersion(negotiatedProtocolVersion),
              }
            : config;

        const [toolsResult, promptsResult, resourcesResult, availableResourceTemplates] =
          await Promise.all([
            safeListTools({ manager, serverId }),
            safeListPrompts({ manager, serverId }),
            safeListResources({ manager, serverId }),
            safeListResourceTemplates({ manager, serverId }),
          ]);

        // A server may answer a list method with an unusable payload; the
        // snapshot models "nothing discovered" rather than throwing, so a
        // missing optional surface never aborts the run.
        const tools = toolsResult?.tools ?? [];
        const prompts = promptsResult?.prompts ?? [];
        const resources = resourcesResult?.resources ?? [];

        const surface: MCPServerSurfaceSnapshot = {
          tools,
          toolNames: tools.map((tool) => tool.name),
          promptNames: prompts.map((prompt) => prompt.name),
          resourceUris: resources.map((resource) => resource.uri),
          resourceTemplateUris: availableResourceTemplates,
          serverCapabilities: initializationInfo?.serverCapabilities as
            | Record<string, unknown>
            | undefined,
        };

        const ctx: MCPClientCheckContext = {
          manager,
          client,
          serverId,
          config: effectiveConfig,
          initializationInfo,
          availableTools: surface.toolNames,
          availablePrompts: surface.promptNames,
          availableResources: surface.resourceUris,
          availableResourceTemplates,
        };

        // Readiness is advisory and must not perturb the verdict, so it is
        // gathered before the checks run and never consulted again.
        const readiness = await collectClientReadiness(ctx, surface);

        if (selectedClientChecks.length === 0) {
          return { checks: [], config: effectiveConfig, surface, readiness };
        }

        const results: MCPCheckResult[] = [];
        let connectionLost = false;

        for (const check of selectedClientChecks) {
          // Era gate first: an era-inapplicable check is a deterministic skip
          // that never runs `check.run`, so it neither observes nor affects
          // the `connectionLost` sequencing below.
          const eraSkip = eraGate(
            check,
            effectiveConfig.era,
            effectiveConfig.protocolVersion,
          );
          if (eraSkip) {
            results.push(eraSkip);
            continue;
          }

          if (connectionLost) {
            results.push(
              couldNotRunResult(
                check,
                "Skipping check because the MCP client session is no longer healthy",
              ),
            );
            continue;
          }

          try {
            results.push(await check.run(ctx));
          } catch (error) {
            results.push(
              failedResult(
                check,
                0,
                errorMessage(error),
                undefined,
                error,
              ),
            );
            connectionLost = true;
          }
        }

        return {
          checks: results,
          config: effectiveConfig,
          surface,
          readiness,
        };
      },
      {
        clientName: config.clientName,
        timeout: config.checkTimeout,
      },
    );

  } catch (error) {
    // A raw-only Auto run has no client-backed check on which to report a
    // failed negotiation. Reject the run instead of silently executing raw
    // checks with the legacy default after detection failed.
    if (selectedClientChecks.length === 0) {
      throw error;
    }

    const checks: MCPCheckResult[] = [];

    // Era gate applies even when the connection could not be established: an
    // era-inapplicable check is a deterministic era-skip, never a failure. On a
    // modern run a connect error must NOT surface a legacy-only check (e.g.
    // `server-initialize`) as failed, or `result.passed` goes false for a check
    // that does not apply to the run's era. The surfaced connect failure is
    // pinned to the first ERA-APPLICABLE check (in legacy that is
    // `selectedClientChecks[0]`, byte-identical to the pre-era-awareness path).
    const firstApplicableCheck = selectedClientChecks.find(
      (check) => !eraGate(check, config.era, config.protocolVersion),
    );

    // Degenerate modern-era selection: EVERY selected client check is
    // legacy-only, so there is no era-applicable check to pin the connect
    // failure to (`firstApplicableCheck` is undefined). The normal loop below
    // would era-skip all of them and the connection error would vanish — the
    // run could report `passed` despite never connecting. Anchor the failure on
    // the first selected check so a genuine connect failure ALWAYS surfaces as
    // at least one failed result. This branch is unreachable in the legacy era
    // (every check applies to `legacy`, so `firstApplicableCheck` is always
    // defined), keeping the legacy path byte-identical to pre-era-awareness.
    if (!firstApplicableCheck) {
      return {
        checks: selectedClientChecks.map((check, index) =>
          index === 0
            ? failedResult(check, 0, errorMessage(error), undefined, error)
            : (eraGate(check, config.era, config.protocolVersion) ??
              couldNotRunResult(
                check,
                "Skipping check because the MCP client session could not be established",
              )),
        ),
        config,
        readiness: [],
      };
    }

    for (const check of selectedClientChecks) {
      const eraSkip = eraGate(check, config.era, config.protocolVersion);
      if (eraSkip) {
        checks.push(eraSkip);
        continue;
      }

      if (
        check.id === "server-initialize" ||
        check.id === firstApplicableCheck?.id
      ) {
        checks.push(
          failedResult(
            check,
            0,
            errorMessage(error),
            undefined,
            error,
          ),
        );
      } else {
        checks.push(
          couldNotRunResult(
            check,
            "Skipping check because the MCP client session could not be established",
          ),
        );
      }
    }

    return { checks, config, readiness: [] };
  }
}

export class MCPConformanceTest {
  private readonly config: NormalizedMCPConformanceConfig;

  constructor(config: MCPConformanceConfig) {
    this.config = normalizeMCPConformanceConfig(config);
  }

  async run(): Promise<MCPConformanceResult> {
    const startedAt = Date.now();
    const selectedCheckIds = buildCheckSelection(this.config);
    // ONE record for the whole run, opened before the first byte moves. The
    // raw families run concurrently and each builds its own requests, so
    // "everything this run observed" only exists if something collects it —
    // which is what the wire-schema check reads.
    const recorder = new WireObservationRecorder();
    const clientRun = await runClientChecks(
      this.config,
      selectedCheckIds,
      recorder,
    );

    const rawContext: RawHttpCheckContext = {
      config: clientRun.config,
      serverUrl: clientRun.config.serverUrl,
      fetchFn: clientRun.config.fetchFn,
      surface: clientRun.surface,
      recorder,
    };

    const [
      protocolChecks,
      securityChecks,
      transportChecks,
      modernChecks,
      rawReadiness,
    ] = await Promise.all([
      runProtocolChecks(rawContext, selectedCheckIds),
      runSecurityChecks(rawContext, selectedCheckIds),
      runTransportChecks(rawContext, selectedCheckIds),
      runModernChecks(rawContext, selectedCheckIds),
      collectRawReadiness(rawContext),
    ]);

    // LAST, and deliberately not inside the `Promise.all` above: its subject is
    // everything the other families made the server say, so it has to run after
    // all of them or it would grade a partial record and call it complete.
    const wireSchema = await runWireSchemaCheck(
      rawContext,
      selectedCheckIds,
      recorder,
    );

    const checks = [
      ...clientRun.checks,
      ...protocolChecks,
      ...securityChecks,
      ...transportChecks,
      ...modernChecks,
      ...wireSchema.results,
    ];
    // The tally reports EVERYTHING that ran, pending checks included: a report
    // that hid them would misstate what the run did. Only the VERDICT is
    // narrowed to the scored set, below.
    const categorySummary = summarizeChecks(checks);

    // Which of these checks the active profile scores. A check outside the
    // frozen manifest still ran and still shows its verdict in `checks`, but it
    // is excluded from the verdict and from the score: a MUST check added this
    // week must not retroactively fail a server that was green last week.
    const profile = conformanceProfile("mcp-protocol");
    const { scored, pending } = partitionByProfile(checks, profile);

    // A check that COULD NOT RUN is neither a violation nor a pass: the
    // obligation went untested, so the run is `incomplete`. Collapsing that
    // into "nothing failed" is what let a run with unexercised checks report
    // success.
    // An empty SCORED set is not the same fact as an empty CHECK set.
    // `decideConformanceOutcome([])` reports "no checks were selected, so this
    // run establishes nothing" — true for an empty selection, and the exact
    // opposite of what happened when checks ran and every one of them is
    // pending (e.g. `checkIds: ["wire-schema-valid"]`).
    const verdict =
      scored.length === 0 && pending.length > 0
        ? {
            outcome: "incomplete" as const,
            incompleteReason: `all ${pending.length} selected check(s) ran but are unscored by profile ${profile.id}@${profile.version}, so this run establishes no conformance verdict`,
          }
        : decideConformanceOutcome(scored);

    return {
      // Readiness is deliberately absent from this expression: the verdict is
      // a statement about MUSTs only (§15.4).
      passed: verdict.outcome === "passed",
      outcome: verdict.outcome,
      ...(verdict.incompleteReason
        ? { incompleteReason: verdict.incompleteReason }
        : {}),
      serverUrl: this.config.serverUrl,
      // The EFFECTIVE version: the pin, or the negotiated upgrade when the
      // run connected without one. Undefined for an unpinned raw-only run.
      ...(clientRun.config.protocolVersion !== undefined
        ? { protocolVersion: clientRun.config.protocolVersion }
        : {}),
      checks,
      summary:
        pending.length > 0
          ? `${buildSummary(scored)}, ${pending.length} pending (unscored by profile ${profile.id}@${profile.version})`
          : buildSummary(scored),
      durationMs: Date.now() - startedAt,
      categorySummary,
      readiness: [...clientRun.readiness, ...rawReadiness],
      profile: buildConformanceProfileStamp({
        profile,
        checks,
        protocolVersion: clientRun.config.protocolVersion,
        // Only when the schema pass actually ran: a digest on a run that
        // validated nothing would claim provenance for a measurement that
        // never happened.
        ...(wireSchema.report
          ? {
              schemaDigest: wireSchema.report.schemaDigest,
              ...(wireSchema.report.extensionIds.length > 0
                ? { extensionVersions: wireSchema.report.extensionRevisions }
                : {}),
            }
          : {}),
      }),
    };
  }
}
