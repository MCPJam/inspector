import type { ModelReasoningEffort, ModelSelection } from "@mcpjam/sdk";
/**
 * A harness turn's lease wiring for the key it runs on, built once at the top
 * of `runHarnessTurn` from the turn's saved selection. The turn reserves its
 * box, starts its lease and prepares a local runtime through it.
 *
 * On an ORG selection (Claude Code on the organization's Anthropic key, Codex
 * on its OpenAI key) the turn:
 *  - runs the selection's canonical id, since the row's own id is the native
 *    one (`claude-sonnet-4-5`), which nothing the lease knows canonicalizes;
 *  - carries the selection to `/reserve`, the box start and the local
 *    preparation, and hands the start the credential revision `/reserve`
 *    prepared, so a key replaced in between is refused;
 *  - adds whose key it runs on to the runtime fingerprint: opaque provider
 *    state belongs to an account, so a Gateway session never resumes onto an
 *    org key (or back), and two connections are two accounts;
 *  - resumes only state stamped with its lease's revision, and stamps the
 *    state it commits (`org-credential-continuity.ts`);
 *  - runs the runtime natively, on the leased profile and native id.
 * A hosted turn's answers are the hosted defaults. Either kind reads the
 * proxy's recorded refusal back when it fails after a model call.
 */
import { harnessOrgUpstream } from "@/shared/harness-model-support";
import { getCanonicalModelId } from "@/shared/types";
import type {
  InfraFailureEvidence,
  ModelEndpointOwnership,
} from "../infra-failure-evidence.js";
import {
  orgHarnessSelection,
  type OrgHarnessSelection,
} from "./harness-availability.js";
import {
  reserveHarnessBox,
  startHarnessModelBroker,
} from "./harness-model-broker.js";
import {
  failedTurnEvidence,
  type HarnessOrgLeaseUpstream,
} from "./harness-org-lease.js";
import { HarnessInfraSetupError } from "./harness-provider-error.js";
import {
  prepareLocalHarnessTurn,
  type PrepareLocalHarnessTurnArgs,
} from "./local/local-turn.js";
import { prepareLocalOnOrgKey } from "./local/org-key-preparation.js";
import {
  resetForReplacedKey,
  resumeStateToCommit,
  stateForTurn,
  stateFromAnotherKey,
} from "./org-credential-continuity.js";
import type { MCPJamHandlerOptions } from "../mcpjam-stream-handler.js";
import type { HarnessRuntimeAdapter } from "./registry.js";

export class OrgLeaseTurn {
  /** MCPJam's model proxy; on the org's key it serves a first-party provider. */
  readonly brokeredEndpoint: ModelEndpointOwnership;
  private readonly selection: OrgHarnessSelection | undefined;
  private readonly requestedSelection: ModelSelection | undefined;
  /** The selection a reserve, start or local-prepare body carries. */
  private readonly selectionField: { modelSelection?: OrgHarnessSelection };
  private readonly profile: string | undefined;
  private readonly bearer: string | undefined;
  /** A run (eval, swarm) owns the local session id and cleans up only it. */
  private readonly runOwnsSession: boolean;
  private readonly turnStartedAt = Date.now();
  /** The lease's upstream, from the backend's answer once the lease exists. */
  private upstream: HarnessOrgLeaseUpstream | undefined;
  /** The revision the claimed lane's state was stamped with. */
  private stampedRevision: string | undefined;
  /** The hashed revision `/reserve` prepared this turn for. */
  private preparedRevision: string | undefined;
  /** The lease's run, for reading back the proxy's recorded refusal. */
  private leaseRunId: string | undefined;

  constructor(
    options: Pick<
      MCPJamHandlerOptions,
      "harness" | "modelSelection" | "authHeader" | "harnessExecutionTarget"
    >,
  ) {
    this.selection = orgHarnessSelection(options.modelSelection);
    this.requestedSelection =
      options.modelSelection?.source === "hosted"
        ? options.modelSelection
        : this.selection;
    this.profile = this.selection
      ? harnessOrgUpstream(options.harness ?? "")?.profile
      : undefined;
    this.bearer = options.authHeader;
    this.runOwnsSession = Boolean(
      options.harnessExecutionTarget?.localSessionId,
    );
    this.brokeredEndpoint = this.selection ? "byok_hosted" : "platform";
    this.selectionField = this.selection
      ? { modelSelection: this.selection }
      : {};
  }

  private requestedSelectionField(reasoningEffort?: ModelReasoningEffort) {
    if (!this.requestedSelection) return {};
    return {
      modelSelection:
        reasoningEffort === undefined
          ? this.requestedSelection
          : {
              ...this.requestedSelection,
              settings: {
                ...this.requestedSelection.settings,
                reasoningEffort,
              },
            },
    };
  }

  /** The turn's canonical model id. */
  modelId(rawModelId: string, provider: string | undefined): string {
    return this.selection
      ? this.selection.modelId
      : getCanonicalModelId(rawModelId, provider);
  }

  /**
   * The runtime fingerprint's credential dimension. A replaced key is caught
   * by the revision stamped into the committed state, not here. Hosted turns
   * carry none, so no existing session's hash moves.
   */
  fingerprint(): { credential?: string } {
    if (!this.selection || !this.profile) return {};
    const connectionId = String(this.selection.connectionRef.id);
    return { credential: `org:${connectionId}:${this.profile}` };
  }

  /** The claimed state as the adapter wrote it; its stamp is kept here. */
  claimed<S extends { resumeState: unknown }>(state: S | null): S | null {
    const claim = stateForTurn(state, Boolean(this.selection));
    this.stampedRevision = claim.credentialRevision;
    return claim.state;
  }

  /**
   * Reserve the box, or fail typed: the box claim is our sandbox layer's
   * concurrency control. An org selection is resolved by the backend HERE,
   * before anything is installed, and one it refused is a CONFIGURATION
   * failure that keeps the backend's own code (`provider_mismatch`, …).
   */
  async reserve(
    args: Omit<Parameters<typeof reserveHarnessBox>[0], "modelSelection">,
  ): Promise<void> {
    const reservation = await reserveHarnessBox({
      ...args,
      ...this.selectionField,
    });
    if (!reservation.ok) {
      throw new HarnessInfraSetupError(reservation.error, {
        source: "sandbox_setup",
        code:
          this.selection && reservation.code
            ? reservation.code
            : "harness_box_reservation_failed",
        httpStatus: reservation.status,
      });
    }
    this.preparedRevision = reservation.credentialRevision;
  }

  /**
   * Start the box's lease. An org start carries the revision `/reserve`
   * prepared, so a key replaced since is refused.
   */
  async start(
    args: Omit<
      Parameters<typeof startHarnessModelBroker>[0],
      "modelSelection" | "expectedCredentialRevision"
    >,
  ) {
    const broker = await startHarnessModelBroker({
      ...args,
      ...this.requestedSelectionField(args.reasoningEffort),
      ...(this.selection && this.preparedRevision
        ? { expectedCredentialRevision: this.preparedRevision }
        : {}),
    });
    if (broker.ok) {
      this.leaseRunId = args.runId;
      if (this.selection) this.upstream = broker.orgUpstream;
    }
    return broker;
  }

  /**
   * Prepare a local turn confirmed on the key it runs on
   * (`prepareLocalOnOrgKey`). A replaced key prepares again under a fresh
   * session id, which no longer resumes.
   */
  async prepareLocal<E extends { resume: boolean }>(
    args: Omit<PrepareLocalHarnessTurnArgs, "sessionId" | "modelSelection">,
    local: {
      sessionId: string;
      eligibility: E | undefined;
      continuity: { state: unknown } | undefined;
      isApprovalResume: boolean;
    },
  ) {
    const preparation = await prepareLocalOnOrgKey({
      prepare: (sessionId) =>
        prepareLocalHarnessTurn({
          ...args,
          sessionId,
          ...this.requestedSelectionField(args.reasoningEffort),
        }),
      sessionId: local.sessionId,
      onOrgKey: Boolean(this.selection),
      resumes: Boolean(local.eligibility?.resume),
      continuity: local.continuity,
      stampedRevision: this.stampedRevision,
      isApprovalResume: local.isApprovalResume,
      runOwnsSession: this.runOwnsSession,
    });
    if (this.selection) this.upstream = preparation.prepared.orgUpstream;
    this.leaseRunId = preparation.prepared.brokerRunId;
    return {
      prepared: preparation.prepared,
      sessionId: preparation.sessionId,
      eligibility:
        preparation.keyReplaced && local.eligibility
          ? { ...local.eligibility, resume: false }
          : local.eligibility,
    };
  }

  /**
   * The lane once the lease's revision is known. A lane whose state was
   * stamped with another revision (the org replaced its key), or never
   * stamped, starts a fresh runtime session, visibly, rather than carrying
   * one account's opaque provider state into another's.
   */
  continuityOnLeasedKey<C extends { state: unknown; stateVersion: number }>(
    continuity: C | undefined,
  ): C | undefined {
    return this.upstream &&
      continuity &&
      stateFromAnotherKey(
        continuity,
        this.stampedRevision,
        this.upstream.credentialRevision,
      )
      ? resetForReplacedKey(continuity)
      : continuity;
  }

  /** The runtime's native model: the leased native id on an org key. */
  nativeModel(
    adapter: Pick<HarnessRuntimeAdapter, "toNativeModel">,
    modelId: string,
  ) {
    const upstream = this.runtimeUpstream();
    return upstream
      ? adapter.toNativeModel?.(modelId, upstream)
      : adapter.toNativeModel?.(modelId);
  }

  /** The `createHarness` field naming the native upstream, if any. */
  runtimeField() {
    const upstream = this.runtimeUpstream();
    return upstream ? { upstream } : {};
  }

  /** The resume state a turn commits, stamped with its lease's revision. */
  commitState(resumeState: unknown): unknown {
    return resumeStateToCommit(resumeState, this.upstream);
  }

  /**
   * The evidence a failed turn reports. The proxy's own refusal (the org's
   * key rejected or replaced, its policy, a lease cap) reaches the runtime as
   * a bare refusal status or as nothing typed; the proxy recorded its reason
   * on the lease, so it is read back.
   */
  failedTurnEvidence(
    evidence: InfraFailureEvidence | undefined,
    modelInvoked: boolean,
  ): Promise<InfraFailureEvidence | undefined> {
    return failedTurnEvidence({
      evidence,
      modelInvoked,
      leaseRunId: this.leaseRunId,
      bearer: this.bearer,
      turnStartedAt: this.turnStartedAt,
    });
  }

  private runtimeUpstream() {
    return (
      this.upstream && {
        profile: this.upstream.profile,
        nativeModelId: this.upstream.nativeModelId,
      }
    );
  }
}
