import { resolveLocalMachinePolicy } from "./local-machine-policy.js";
import type { BrowserPageToolsSnapshot } from "../../utils/built-in-tools/browser.js";
import {
  peekPageToolsForChatTurn,
  pageToolsSnapshotFrom,
} from "../browserd/page-tools-peek.js";
import { type MintedDeclaredTool } from "@/shared/declared-tools";
import { webmcpPageToolsMode } from "../../config.js";
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";
import { type Context } from "hono";
import { ErrorCode, WebRouteError } from "../../routes/web/auth.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import {
  planScenarioSandbox,
  scenarioHarnessRepublishRefusal,
  shouldWarnSecretsUndelivered,
  readComputerSandboxMode,
  readComputerSandboxHarness,
} from "../../utils/scenario-runtime-config.js";
import {
  scenarioHarnessBoxRefusal,
  scenarioHarnessProvisionRefusal,
} from "../../routes/web/scenario-harness-refusals.js";
import {
  resolveHostTools,
  type TrustedSandboxBinding,
} from "../../utils/built-in-tools/registry.js";
import {
  ackScenarioSandboxNotices,
  isScenarioSandboxNotice,
  provisionScenarioSandbox,
} from "../../utils/computers/control-plane-client.js";
import {
  type HarnessBox,
  acquireHarnessBox,
  canProvisionHarnessBoxes,
} from "../../utils/harness/harness-box.js";
import {
  acquirePlaygroundHarnessBox,
  describePlaygroundBoxRefusal,
  playgroundCredentialRefusal,
  playgroundHarnessBoxReason,
  playgroundHarnessBoxUnavailableReason,
} from "../../utils/harness/playground-box.js";
import {
  isSandboxNoticeReason,
  type SandboxNoticeReason,
} from "@/shared/sandbox-notice";
import { BASH_TOOL_NAME } from "../../utils/built-in-tools/bash.js";
import {
  appendSandboxNoticeContext,
  maybeAppendEnvironmentContext,
} from "../../utils/computers/environment-context.js";
import { buildMcpjamPlatformClient } from "../../routes/web/mcpjam-platform-client.js";
import {
  fetchRuntimeSecrets,
  markRuntimeSecretsDelivered,
  toSecretEnv,
} from "../../utils/harness/runtime-secrets.js";
import { resolveBrowserSecrets } from "../../utils/secrets/browser-secrets.js";
import { guestBrowserProject } from "../../utils/computers/browser-rollout.js";
import { logger } from "../../utils/logger.js";
import { resolveManagedTurnSetup } from "./managed-setup.js";
import { prepareManagedConnections } from "./managed-connections.js";
import { TurnResources } from "./resources.js";

type ManagedSetup = Extract<
  Awaited<ReturnType<typeof resolveManagedTurnSetup>>,
  { value: unknown }
>["value"];
export async function prepareManagedTools(args: {
  c: Context;
  rawBody: Record<string, unknown>;
  bearerToken: string;
  localIngress: boolean;
  resources: TurnResources;
  setup: Pick<
    ManagedSetup,
    | "hostedBody"
    | "body"
    | "scenarioId"
    | "surface"
    | "hostId"
    | "turnMode"
    | "hostRuntimeConfig"
    | "environmentSpec"
    | "scenarioEnvironment"
    | "pinsEnvironment"
    | "environmentServers"
    | "resolvedExecution"
    | "builtInToolPolicy"
    | "localBrowserSettingsUnavailable"
    | "turnBuiltInToolIds"
    | "systemPrompt"
    | "requireToolApproval"
    | "harnessExecutionTarget"
    | "executionScope"
    | "scenarioParticipant"
  >;
  connections: Pick<
    Awaited<ReturnType<typeof prepareManagedConnections>>,
    "validatedPageTools"
  >;
}) {
  const { c, rawBody, bearerToken, localIngress, resources } = args;
  let scenarioBox: HarnessBox | undefined;
  let {
    hostedBody,
    body,
    scenarioId,
    hostId,
    turnMode,
    hostRuntimeConfig,
    environmentSpec,
    scenarioEnvironment,
    pinsEnvironment,
    environmentServers,
    resolvedExecution,
    builtInToolPolicy,
    turnBuiltInToolIds,
    localBrowserSettingsUnavailable,
    systemPrompt,
    requireToolApproval,
    harnessExecutionTarget,
    executionScope,
    scenarioParticipant,
  } = args.setup;
  let { validatedPageTools } = args.connections;
  // ── Phase 4: the scenario's own EPHEMERAL sandbox ────────────────────────
  // An env-backed scenario whose backend says `computerSandbox: 'ephemeral'`
  // runs bash on a per-CONVERSATION disposable box booted from the
  const secretsFetch = c.get("guestId")
    ? { ok: true as const, secrets: [] }
    : await fetchRuntimeSecrets(bearerToken, {
        projectId: hostedBody.projectId,
        ...(environmentServers
          ? { environmentId: environmentServers.environmentRef.environmentId }
          : {}),
        ...(body.chatSessionId ? { chatSessionId: body.chatSessionId } : {}),
      });
  // A FAILED FETCH IS NOT "NO SECRETS" — IT FORKS THE SESSION.
  //
  // The tri-state exists precisely so a transient Convex failure cannot read
  const runtimeSecrets = secretsFetch.ok ? secretsFetch.secrets : null;
  const secretsUnavailable = !secretsFetch.ok;
  const secretEnv = runtimeSecrets ? toSecretEnv(runtimeSecrets) : undefined;
  // Fired by whichever adapter actually hands the values over — a bash
  // command that carries them, or a harness session that starts holding them.
  //
  const markSecretsDelivered =
    secretEnv && Object.keys(secretEnv).length > 0
      ? () => {
          void markRuntimeSecretsDelivered(bearerToken, {
            projectId: hostedBody.projectId,
            ...(environmentServers
              ? {
                  environmentId:
                    environmentServers.environmentRef.environmentId,
                }
              : {}),
            secretCount: Object.keys(secretEnv).length,
          });
        }
      : undefined;

  // Reuses this turn's list; a failed read means no secrets, so every
  // placeholder is refused.
  const browserSecrets = await resolveBrowserSecrets({
    resolved: runtimeSecrets ?? [],
  });

  // A CLOUD harness needs a machine whether or not it asks for `bash`, and
  // takes the conversation's box ONLY when the backend says its harness runs
  // there (`computerSandbox.harness`). Without that field — an older backend,
  const harnessWantsScenarioBox =
    Boolean(resolvedExecution.harness) &&
    !harnessExecutionTarget &&
    turnMode === "recorded" &&
    Boolean(scenarioId) &&
    readComputerSandboxHarness(hostRuntimeConfig);
  const computerSandboxMode =
    turnMode === "recorded" &&
    scenarioId &&
    (!resolvedExecution.harness || harnessWantsScenarioBox)
      ? readComputerSandboxMode(hostRuntimeConfig)
      : null;
  let sandboxBinding: TrustedSandboxBinding | undefined;
  let sandboxNotices: SandboxNoticeReason[] | undefined;
  // Set only when the backend PEEKED (returned notices still pending). The
  // stream layer calls this right after writing the SSE parts; until it does,
  // the notices stay pending server-side and are re-delivered next turn.
  let ackSandboxNotices:
    ((delivered: SandboxNoticeReason[]) => void) | undefined;
  // Drop the personal-computer resource for every suppressing plan, so
  // `bash` is not advertised at all rather than falling back to the member's
  // own box — which is precisely the behaviour this feature replaces:
  const sandboxPlan = planScenarioSandbox({
    mode: computerSandboxMode,
    bashRequested: (turnBuiltInToolIds ?? []).includes(BASH_TOOL_NAME),
    harnessRequested: harnessWantsScenarioBox,
    ephemeralCloudAvailable: canProvisionHarnessBoxes(),
    hasChatSessionId: Boolean(body.chatSessionId),
    secretsUnavailable,
    environmentSelectsSecrets:
      scenarioEnvironment?.selectsMaterializedSecrets === true,
  });
  // A HARNESS turn has no shell to quietly drop: the only other machine is
  // the member's personal computer, which a scenario conversation's harness
  // must never run on once the backend has put it on a disposable box.
  // Refused before anything is provisioned, with the reason the plan gave.
  if (
    harnessWantsScenarioBox &&
    computerSandboxMode !== null &&
    sandboxPlan.action === "suppress"
  ) {
    throw scenarioHarnessBoxRefusal(
      resolvedExecution.harness!,
      sandboxPlan.suppressReason,
    );
  }
  let suppressComputerResource = sandboxPlan.action === "suppress";
  if (sandboxPlan.suppressReason === "no_chat_session_id") {
    // The conversation id IS the isolation boundary (`scopeKey =
    // scenario:<chatSessionId>`). Without one there is nothing to key a box
    // to, and binding anyway would put every session that omits it on one
    // shared box. No shell beats the wrong shell.
    logger.warn(
      "[chat-v2] ephemeral scenario sandbox requested without a chatSessionId; bash suppressed",
      { scenarioId },
    );
  } else if (sandboxPlan.suppressReason === "secrets_unavailable") {
    // The scenario counterpart of the harness fork. A harness session that
    // cannot establish its secret state starts a fresh bridge, which holds
    // nothing; a scenario conversation's box is keyed to the conversation and
    logger.warn(
      "[chat-v2] secret resolution failed for a conversation with a persistent sandbox; bash suppressed for this turn",
      { scenarioId },
    );
    if (sandboxPlan.notice) sandboxNotices = [sandboxPlan.notice];
  } else if (sandboxPlan.suppressReason === "not_a_data_plane") {
    logger.warn(
      "[chat-v2] ephemeral scenario sandbox requested but this server is not a computers data plane; bash suppressed without provisioning",
      { scenarioId },
    );
    if (sandboxPlan.notice) sandboxNotices = [sandboxPlan.notice];
  }
  if (sandboxPlan.action === "provision" && scenarioId && body.chatSessionId) {
    const chatSessionId = body.chatSessionId;
    let provisioned:
      Awaited<ReturnType<typeof provisionScenarioSandbox>> | undefined;
    // The shared box holder: the box's idle clock keeps running for as long
    // as this turn does (a long harness turn would otherwise outlive the
    // scenario TTL), and stops when the turn's stream completes.
    const acquired = await acquireHarnessBox({
      surface: "scenario",
      provision: async () => {
        provisioned = await provisionScenarioSandbox({
          bearer: bearerToken,
          scenarioId,
          chatSessionId,
          signal: c.req.raw.signal as AbortSignal | undefined,
        });
        return provisioned.ok
          ? {
              ok: true as const,
              box: {
                sandboxRowId: provisioned.value.sandboxRowId,
                sandboxId: provisioned.value.sandboxId,
                ...(provisioned.value.workdir
                  ? { workdir: provisioned.value.workdir }
                  : {}),
              },
            }
          : { ok: false as const, refusal: provisioned };
      },
    });
    if (acquired.ok) {
      scenarioBox = acquired.box;
      resources.own(() => acquired.box.release());
    }
    if (provisioned?.ok) {
      sandboxBinding = {
        sandboxId: provisioned.value.sandboxId,
        ...(provisioned.value.workdir
          ? { workdir: provisioned.value.workdir }
          : {}),
        // Tell the model the truth about the box's lifetime. The default
        // (`run`) copy says it is destroyed after this session — a scenario
        // box is not, and a model that believes otherwise won't build work
        // up across turns, which is the whole point of a persistent shell.
        lifetime: "conversation",
      };
      const notices = (provisioned.value.notices ?? []).filter(
        isSandboxNoticeReason,
      );
      if (notices.length > 0) sandboxNotices = notices;
      // PEEK/ACK (mcpjam-backend #829). The control plane hands the notice
      // over WITHOUT consuming it and waits for us to confirm it reached
      // the wire, because the SSE writer does not exist yet — provisioning
      const sandboxRowId = provisioned.value.sandboxRowId;
      if (provisioned.value.noticeAckPending && notices.length > 0) {
        ackSandboxNotices = (delivered) => {
          // Only BACKEND-mintable notices enter the ack protocol —
          // inspector-minted reasons (`sandbox_unavailable`) have no
          // backend row to ack against.
          const ackable = delivered.filter(isScenarioSandboxNotice);
          if (ackable.length === 0) return;
          void ackScenarioSandboxNotices({
            bearer: bearerToken,
            sandboxRowId,
            notices: ackable,
          });
        };
      }
    } else if (harnessWantsScenarioBox) {
      // A harness has nothing to degrade to — refuse, never the member's
      // personal computer. 503 (at capacity, a sibling still booting)
      // resolves on its own, so the tester can simply retry.
      logger.warn("[chat-v2] scenario harness box provision failed", {
        scenarioId,
        status: provisioned?.ok === false ? provisioned.status : undefined,
        error: provisioned?.ok === false ? provisioned.error : undefined,
      });
      throw scenarioHarnessProvisionRefusal(
        resolvedExecution.harness!,
        provisioned?.ok === false ? provisioned : undefined,
        scenarioParticipant,
      );
    } else {
      // Degrade to a turn with no shell rather than failing the turn: the
      // conversation is still useful, and 503 (at capacity / a sibling call
      // still booting) resolves on its own by the next turn.
      logger.warn(
        "[chat-v2] scenario sandbox provision failed; running without bash",
        {
          scenarioId,
          status: provisioned?.ok === false ? provisioned.status : undefined,
          error: provisioned?.ok === false ? provisioned.error : undefined,
        },
      );
      suppressComputerResource = true;
    }
  }
  // A SCENARIO-scoped cloud harness with no box bound to it: the backend sent
  // no harness marker (a host-backed scenario, or a backend older than the
  // `computerSandbox.harness` field), so there is nothing to provision, and
  if (
    resolvedExecution.harness &&
    !harnessExecutionTarget &&
    executionScope?.kind === "swarm" &&
    !scenarioBox
  ) {
    throw scenarioHarnessRepublishRefusal({
      harness: resolvedExecution.harness!,
      accessKind: hostRuntimeConfig?.accessKind,
    });
  }

  // ── PLAYGROUND FALLBACK: a disposable computer for THIS conversation ──
  //
  // A Playground harness turn runs on the member's personal computer, which
  const playgroundBoxReason = playgroundHarnessBoxReason({
    harnessId: resolvedExecution.harness,
    localExecution: Boolean(harnessExecutionTarget),
    isScenarioSession: turnMode === "recorded",
    comparePane: hostedBody.comparePane === true,
  });
  // A guest has no project computer to protect and no project to hold a box
  // for, so it keeps its existing path (and, on a scenario, its own box).
  if (playgroundBoxReason && resolvedExecution.harness && !c.get("guestId")) {
    const unavailable = playgroundHarnessBoxUnavailableReason(
      resolvedExecution.harness,
      playgroundBoxReason,
    );
    if (unavailable) {
      throw new WebRouteError(
        503,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        unavailable,
        { reason: "NOT_A_DATA_PLANE" },
      );
    }
    if (!hostedBody.chatSessionId) {
      // The conversation id is the isolation boundary (one box per
      // conversation). Without one every such turn would share one box.
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `This turn runs the ${resolvedExecution.harness} harness on a disposable computer, which belongs to one conversation, and this turn named none.`,
        { reason: "NO_CHAT_SESSION_ID" },
      );
    }
    // The environment whose grant the box carries: the turn's own when it
    // targets one; otherwise, for a client that signs in with the member's
    // own account, a HIDDEN ad-hoc environment selecting the member's key
    const playgroundEnvironmentId =
      pinsEnvironment || playgroundBoxReason === "credential"
        ? environmentSpec?.environmentRef.environmentId
        : undefined;
    // The credential check the harness turn would fail, run BEFORE the box
    // is booted: a refused Cursor turn must not pay for a box first. Same
    // function and inputs as `runHarnessTurn`'s own check.
    if (playgroundBoxReason === "credential") {
      const credentialRefusal = await playgroundCredentialRefusal({
        harnessId: resolvedExecution.harness,
        secretEnv,
        bearer: bearerToken,
        projectId: hostedBody.projectId,
        ...(playgroundEnvironmentId
          ? { environmentId: playgroundEnvironmentId }
          : {}),
      });
      if (credentialRefusal) {
        throw new WebRouteError(409, ErrorCode.CONFLICT, credentialRefusal, {
          reason: "EXTERNAL_ACCOUNT_CREDENTIAL_UNAVAILABLE",
        });
      }
    }
    const acquired = await acquirePlaygroundHarnessBox({
      bearer: bearerToken,
      projectId: hostedBody.projectId,
      chatSessionId: hostedBody.chatSessionId,
      ...(playgroundEnvironmentId
        ? { projectEnvironmentId: playgroundEnvironmentId }
        : {}),
      harness: resolvedExecution.harness,
      signal: c.req.raw.signal as AbortSignal | undefined,
    });
    if (!acquired.ok) {
      logger.warn("[chat-v2] playground harness box provision failed", {
        reason: playgroundBoxReason,
        status: acquired.refusal.status,
        error: acquired.refusal.error,
      });
      const described = describePlaygroundBoxRefusal(
        resolvedExecution.harness,
        playgroundBoxReason,
        acquired.refusal,
      );
      const refusalError = new WebRouteError(
        described.status,
        described.status === 429
          ? ErrorCode.RATE_LIMITED
          : described.status === 403
            ? ErrorCode.FORBIDDEN
            : described.status === 409
              ? ErrorCode.CONFLICT
              : described.status === 503
                ? ErrorCode.RATE_LIMITED
                : ErrorCode.INTERNAL_ERROR,
        described.message,
        {
          reason: "PLAYGROUND_SANDBOX_PROVISION_FAILED",
          ...(described.code ? { code: described.code } : {}),
        },
      );
      const retryAfterMs =
        described.status === 429 || described.status === 503
          ? acquired.refusal.retryAfterMs
          : undefined;
      throw retryAfterMs !== undefined
        ? refusalError.withHeaders({
            "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
          })
        : refusalError;
    }
    scenarioBox = acquired.box;
    resources.own(() => acquired.box.release());
    // The model's own `bash` rides the same machine as the harness's Shell:
    // two filesystems in one turn is a bug nobody can see.
    sandboxBinding = {
      sandboxId: acquired.box.binding.sandboxId,
      ...(acquired.box.binding.workdir
        ? { workdir: acquired.box.binding.workdir }
        : {}),
      lifetime: "conversation",
    };
  }

  // MATERIALIZED secrets resolved, and nowhere legitimate to put them.
  //
  // `resolveHostTools` reads `secretEnv` ONLY inside its `sandboxBinding`
  if (
    shouldWarnSecretsUndelivered({
      secretCount: secretEnv ? Object.keys(secretEnv).length : 0,
      hasSandboxBinding: Boolean(sandboxBinding),
      harness: resolvedExecution.harness,
    })
  ) {
    getRequestLogger(c, "routes.web.chat-v2").event(
      "chat.secrets.undelivered",
      {
        // COUNT ONLY. Never a name, and never a value: this row is one
        // `secretScrubber` miss away from being the leak the whole feature
        // exists to prevent, and a count answers the operational question.
        secretCount: secretEnv ? Object.keys(secretEnv).length : 0,
        isScenarioSession: turnMode === "recorded",
      },
    );
    sandboxNotices = [...(sandboxNotices ?? []), "secrets_undelivered"];
  }

  const localMachine =
    localIngress && !sandboxBinding
      ? await resolveLocalMachinePolicy({
          c,
          body: {
            projectId: hostedBody.projectId,
            chatSessionId: body.chatSessionId,
            browserEngine: rawBody.browserEngine,
            computerEngine: rawBody.computerEngine,
          },
          builtInToolIds: turnBuiltInToolIds,
          isScenarioSession: turnMode === "recorded",
          localBrowserSettingsUnavailable,
        })
      : undefined;

  // WHAT THE PAGE OFFERS RIGHT NOW, read before the toolset is built.
  //
  // Read-only: this never starts, attaches or reserves a browser (see
  const browserSessionScope =
    body.browserScope === "conversation" &&
    body.chatSessionId &&
    turnMode === "interactive"
      ? {
          kind: "conversation" as const,
          sessionId: body.chatSessionId,
          ...(environmentSpec
            ? { hostId: environmentSpec.host.hostId }
            : hostId
              ? { hostId }
              : {}),
        }
      : undefined;
  const pageToolsPeek = await peekPageToolsForChatTurn({
    ...(browserSessionScope
      ? { conversationId: browserSessionScope.sessionId }
      : {}),
    builtInToolIds: localMachine?.browserUnavailableReason
      ? []
      : turnBuiltInToolIds,
    browserToolId: BROWSER_BUILT_IN_TOOL_ID,
    firstClass: webmcpPageToolsMode() === "first_class",
    isHarnessTurn: Boolean(resolvedExecution.harness),
    // TRANSITIONAL: this client fulfils page tools itself through `page_*`.
    // Advertising the same page's tools twice, under two namespaces with two
    // fulfilment paths, is how a model calls one of each.
    hasV1PageTools: validatedPageTools.length > 0,
    engine: localMachine?.browserEngine === "local" ? "local" : "hosted",
    // The browser tool's own session key: a guest's local Browser is scoped
    // to that guest, never the project's member session on this machine.
    projectId: localMachine?.localBrowserGuestId
      ? guestBrowserProject(
          hostedBody.projectId,
          localMachine.localBrowserGuestId,
        )
      : hostedBody.projectId,
    bearer: bearerToken,
    ...(sandboxBinding?.sandboxRowId
      ? { sandboxRowId: sandboxBinding.sandboxRowId }
      : {}),
  });
  const pageToolsSnapshot = pageToolsSnapshotFrom(pageToolsPeek);

  let advertisedPageTools: MintedDeclaredTool[] = [];
  // Filled by `runWebChatTurn` once `prepareChatV2` has decided which names
  // are spoken for. Only the persisted record reads it — the model's own set
  // is filtered inside the turn, where the decision is made.
  let reservedAgainstPageTools: ReadonlySet<string> | undefined;
  // The generation `advertisedPageTools` belongs to. Starts as the turn's own
  // peek and moves with each refresh: pairing refreshed tools with the
  // turn-start tab and navCounter would persist an identity that never was.
  let advertisedPageToolsBinding = pageToolsSnapshot;
  // The mid-turn refresher, when the browser capability built one. Kept in a
  // mutable slot because `resolveHostTools` is synchronous and fills it by
  // callback, exactly as it does the approval classification.
  let pageToolRefresh:
    | {
        refreshPageTools: (ctx: { signal?: AbortSignal }) => Promise<unknown>;
        currentPageTools: () => MintedDeclaredTool[];
        currentPageToolsBinding: () => BrowserPageToolsSnapshot | undefined;
      }
    | undefined;
  const builtInTools = resolveHostTools(
    {
      builtInToolIds: turnBuiltInToolIds,
      // Computer comes exclusively from the server-resolved runtime config —
      // scenario OR host-by-id — never the request body.
      computer:
        hostRuntimeConfig && !suppressComputerResource
          ? (hostRuntimeConfig as { computer?: unknown }).computer
          : undefined,
    },
    {
      authHeader: bearerToken,
      projectId: hostedBody.projectId,
      ...(localMachine
        ? {
            computerEngine: localMachine.computerEngine,
            browserEngine: localMachine.browserEngine,
            localBrowserGuestId: localMachine.localBrowserGuestId,
            browserConsentToken: localMachine.browserConsentToken,
            localBrowserRequested: localMachine.localBrowserRequested,
            browserUnavailableReason: localMachine.browserUnavailableReason,
            localComputerRequested: localMachine.localComputerRequested,
          }
        : {}),
      ...(executionScope ? { executionScope } : {}),
      ...(body.chatSessionId ? { chatSessionId: body.chatSessionId } : {}),
      ...(body.chatSessionId
        ? { browserCorrelation: { chatSessionId: body.chatSessionId } }
        : {}),
      // Separate from `secretEnv`: these reach browser commands on the
      // hosted engine only, never a box's environment.
      ...(browserSecrets.length > 0 ? { browserSecrets } : {}),
      ...(markSecretsDelivered
        ? { onBrowserSecretDelivered: markSecretsDelivered }
        : {}),
      isGuest: Boolean(c.get("guestId")),
      isScenarioSession: turnMode === "recorded",
      // Lets a spend inside a shared scenario bill the scenario OWNER instead
      // of the visitor, who has no wallet to charge. Only web search reads
      // it today; the model turn and voice already send their own.
      ...(turnMode === "recorded" && scenarioId ? { scenarioId } : {}),
      requireToolApproval,
      // Workspace tools take the server-resolved setting instead (MJ-008).
      workspaceToolApproval: builtInToolPolicy.workspaceToolApproval,
      // Out-of-band and in-process ONLY. Never on `config.computer`:
      // `narrowHostComputer` runs at the top of `resolveHostTools` and
      // rejects anything that isn't `personal`, so a union on the config
      // would be either rejected or — worse — wire-forgeable.
      ...(sandboxBinding ? { sandboxBinding } : {}),
      // Read by the registry ONLY inside its `sandboxBinding` branch: a
      // project's credential reaches a box the project provisioned, never the
      // user's own machine (local runner) or a remote data plane.
      ...(secretEnv && Object.keys(secretEnv).length > 0 ? { secretEnv } : {}),
      ...(markSecretsDelivered
        ? { onSecretEnvDelivered: markSecretsDelivered }
        : {}),
      mcpjamPlatformClient: buildMcpjamPlatformClient(c),
      // A person is watching this surface, so it may advertise interactive
      // browser tools and keep a signed-in profile.
      browserApprovalDelivery: { kind: "attested" },
      ...(resolvedExecution.browserProfileId
        ? { browserProfileId: resolvedExecution.browserProfileId }
        : {}),
      // A Playground conversation owns one durable browser identity. It is
      // resolved lazily by the browser tool on first use, so merely opening
      // the chat does not provision a paid desktop.
      ...(browserSessionScope ? { browserSessionScope } : {}),
      ...(pageToolsSnapshot ? { browserPageTools: pageToolsSnapshot } : {}),
      // ONLY WHERE THE SET CAN ACTUALLY GROW. A harness takes its toolset as
      // a constructor argument and never re-reads it, so claiming it here
      // would build a refresher nothing consumes. NOT gated on the snapshot:
      browserDynamicPageTools: !resolvedExecution.harness,
      // KEPT HERE, dropped later. Which engine runs this turn depends on a
      // Convex-backed runtime resolution that has not happened yet, and one
      // of them — local BYOK — does not consume refreshes; retiring the
      browserRetireInvokeVerb: false as const,
      onBrowserPageTools: ({ minted }) => {
        advertisedPageTools = minted;
      },
      onBrowserToolsRefresh: (refresh) => {
        pageToolRefresh = refresh;
      },
    },
  );

  // Blueprint knowledge/maintenance: when this turn advertises bash, append
  // the pinned image's model-facing context to the system prompt. Tri-state
  // fetch inside — a Convex blip degrades to "no extra context", never a
  const withEnvironmentContext = await maybeAppendEnvironmentContext({
    systemPrompt,
    hasBashTool:
      Boolean(builtInTools?.[BASH_TOOL_NAME]) &&
      !scenarioBox &&
      localMachine?.computerEngine !== "local",
    bearer: bearerToken,
    projectId: hostedBody.projectId,
    ...(executionScope ? { executionScope } : {}),
  });

  // The sandbox notices must reach the MODEL, not only the user's toast.
  //
  // The SSE part warns the human; the model meanwhile still receives the old
  const effectiveSystemPrompt = appendSandboxNoticeContext(
    withEnvironmentContext,
    sandboxNotices,
  );

  return {
    scenarioBox,
    runtimeSecrets,
    secretsUnavailable,
    markSecretsDelivered,
    sandboxNotices,
    ackSandboxNotices,
    localMachine,
    pageToolsSnapshot,
    get advertisedPageTools() {
      return advertisedPageTools;
    },
    set advertisedPageTools(value: typeof advertisedPageTools) {
      advertisedPageTools = value;
    },
    get reservedAgainstPageTools() {
      return reservedAgainstPageTools;
    },
    set reservedAgainstPageTools(value: typeof reservedAgainstPageTools) {
      reservedAgainstPageTools = value;
    },
    get advertisedPageToolsBinding() {
      return advertisedPageToolsBinding;
    },
    set advertisedPageToolsBinding(value: typeof advertisedPageToolsBinding) {
      advertisedPageToolsBinding = value;
    },
    get pageToolRefresh() {
      return pageToolRefresh;
    },
    set pageToolRefresh(value: typeof pageToolRefresh) {
      pageToolRefresh = value;
    },
    builtInTools,
    effectiveSystemPrompt,
  };
}
