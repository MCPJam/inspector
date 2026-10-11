import { pluginBindingDigest } from "./bindings.js";
import { pluginFormFileGrants } from "./form-file-grants.js";
import { openAILegacyFormSchemas } from "../../../shared/plugin-extensions/wire.js";
import {
  PLUGIN_MRTR_PRIVATE_STATE_MAX_BYTES,
  PLUGIN_FORM_SCHEMA_MAX_BYTES,
} from "../../../shared/plugin-form-payload-limits.js";
import type { Context } from "hono";
import {
  resumeInputRequiredOperation,
  type MCPClientManager,
  type MrtrInputCollector,
} from "@mcpjam/sdk";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { HOSTED_MRTR_VERSION } from "../../../shared/mrtr-continuation.js";
import {
  compilePluginForm,
  ownedPluginFormProfile,
  validatePluginFormContent,
} from "../../../shared/plugin-extensions/form-plan.js";
import {
  computeMrtrBindingFingerprintFromManager,
  createHostedMrtrCollector,
  isMrtrSuspendedSignal,
  resolveMrtrAuthPrincipal,
  resolveMrtrNegotiatedEra,
  resumeMrtrContinuationLeg,
} from "../../utils/mrtr-hosted-collector.js";
import {
  createContinuation,
  resuspendContinuation,
  encodeResumeState,
  decodeResumeState,
  cancelContinuation,
} from "../../utils/mrtr-continuation-state.js";
import {
  PluginContinuationRefused,
  PluginContinuationTerminal,
  PluginInvocationError,
  PluginInvocationSuspension,
  withPluginDiagnostic,
  type PluginContinuationSubmission,
  type ResolvedInvocationContext,
  type PluginToolCallParams,
  type TrustedInvocationOwner,
} from "./invocation.js";
import { pluginFormSources } from "./form-sources.js";

/**
 * Forms turned off while an operation's form was pending: its answer is never
 * delivered. The form ends as cancelled, once: the operation's form sources
 * and uploads close, the durable continuation is cancelled (the server never
 * sees the answer), and the caller gets a described refusal that the client
 * writes to its Logs panel.
 */
export async function endPluginMrtrFormsDisabled(input: {
  bearer: string;
  owner: TrustedInvocationOwner;
  invocationId: string;
  continuationId: string;
  serverId: string;
}): Promise<never> {
  pluginFormSources.closeOperation(input.owner, input.invocationId);
  pluginFormFileGrants.closeOperation(input.owner, input.invocationId);
  await cancelContinuation(input.bearer, {
    continuationId: input.continuationId,
    reason: "plugin_forms_disabled",
  });
  throw withPluginDiagnostic(
    new PluginContinuationTerminal("PLUGIN_FORMS_DISABLED"),
    input.serverId,
    "Form cancelled: Forms is turned off for this client",
  );
}

type Operation = {
  authorization: ResolvedInvocationContext;
  invocationId: string;
  params: PluginToolCallParams;
  signal: AbortSignal;
};

/** The original receipt gates resume; the durable store gates the exact wire leg. */
export function createOwnedPluginMrtr(deps: {
  c: Context;
  bearer: string;
  projectId: string;
  serverId: string;
  manager: () => MCPClientManager | undefined;
  assertCurrent: () => Promise<unknown>;
  sourceBinding: { hostId: string; hostRevision: string };
  localFiles?: () => boolean;
  /** Where accepted uploads go; defaults to local files when available. */
  uploadTarget?: () => "local-stdio" | "computer" | undefined;
  /** The client's File resources toggle; absent counts as off. */
  fileResources?: boolean;
  /** The client's CURRENT Forms toggle, as of the latest `assertCurrent`
   * (one fresh admission read). Absent counts as on. */
  formsEnabled?: () => boolean;
}) {
  const formsOff = () => deps.formsEnabled?.() === false;
  const fileResources = deps.fileResources === true;
  const uploadTarget =
    deps.uploadTarget ??
    (() => (deps.localFiles?.() ? ("local-stdio" as const) : undefined));
  const profile = (op: Operation) =>
    ownedPluginFormProfile(
      fileResources,
      op.authorization.origin === "app" ? "mcp-app" : "server",
      uploadTarget() !== undefined,
    );
  let operation: Operation | undefined;
  let captured: PluginInvocationSuspension | undefined;
  const readCaptured = (): PluginInvocationSuspension | undefined => captured;
  const bindSources = (op: Operation, pending: PluginInvocationSuspension) => {
    const requests = pending.pending
      .inputRequests as import("../../../shared/mrtr-continuation.js").MrtrInputRequestDisplay[];
    const bound: ReturnType<typeof pluginFormSources.bind>[] = [];
    try {
      const displays = requests.map((request) => {
        const lease = pluginFormSources.bind({
          owner: op.authorization.owner,
          ...deps.sourceBinding,
          invocationId: op.invocationId,
          origin: op.authorization.origin,
          revision: op.authorization.revision,
          toolName: op.authorization.tool.name,
          parent: {
            kind: "mrtr",
            id: pending.pending.continuationId,
            round: pending.pending.round,
            inputRequestKey: request.key,
          },
          requestedSchema: request.requestedSchema,
          fileResources,
          ...(uploadTarget() ? { uploadTarget: uploadTarget() } : {}),
          expiresAt: pending.pending.expiresAt as number,
        });
        bound.push(lease);
        return { ...request, pluginFormSourceToken: lease.token };
      });
      return new PluginInvocationSuspension({
        ...pending.pending,
        inputRequests: displays,
      });
    } catch (error) {
      for (const lease of bound) lease.release();
      throw error;
    }
  };
  const manager = () => {
    const current = deps.manager();
    if (
      !current ||
      current.getInitializationInfo(deps.serverId)?.protocolVersion !==
        "2026-07-28"
    )
      throw new PluginInvocationError("CONTINUATION_PROTOCOL_DENIED");
    return current;
  };
  const fingerprint = (current: MCPClientManager, op: Operation) =>
    computeMrtrBindingFingerprintFromManager(current, {
      serverId: deps.serverId,
      negotiatedEra: resolveMrtrNegotiatedEra(current, deps.serverId),
      // Separate namespace: the generic resume route cannot claim an owned operation.
      authPrincipal: JSON.stringify([
        "plugin-invocation",
        resolveMrtrAuthPrincipal(deps.c),
        op.authorization.owner,
        op.authorization.origin,
        op.authorization.revision,
        op.invocationId,
      ]),
    });
  const validateRequests = (
    requests: Parameters<MrtrInputCollector>[0]["inputRequests"],
    _op: Operation,
  ) => {
    for (const request of Object.values(requests)) {
      const input = request as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (input.method !== "elicitation/create" || input.params?.mode === "url")
        throw new PluginInvocationError("CONTINUATION_FORM_UNSUPPORTED");
      openAILegacyFormSchemas.params.parse({ ...input.params, mode: "form" });
    }
  };
  const collector: MrtrInputCollector = async (args) => {
    const op = operation;
    if (
      !op ||
      args.state.method !== "tools/call" ||
      args.state.originalParams.name !== op.params.name
    )
      throw new PluginInvocationError("CONTINUATION_OPERATION_DENIED");
    op.signal.throwIfAborted();
    await deps.assertCurrent();
    validateRequests(args.inputRequests, op);
    const current = manager();
    const negotiatedEra = resolveMrtrNegotiatedEra(current, deps.serverId);
    const inner = createHostedMrtrCollector({
      bearer: deps.bearer,
      projectId: deps.projectId,
      serverId: deps.serverId,
      negotiatedEra,
      bindingFingerprint: fingerprint(current, op),
      schemaDisplayMaxBytes: PLUGIN_FORM_SCHEMA_MAX_BYTES,
      encode: (state) =>
        encodeResumeState(state, PLUGIN_MRTR_PRIVATE_STATE_MAX_BYTES),
      create: (bearer, body, signal) =>
        createContinuation(
          bearer,
          { ...body, privateResumeState: true },
          signal,
        ),
      emit: (event) => {
        if (event.kind === "input_required")
          captured = new PluginInvocationSuspension({
            ...event,
            status: "input_required",
            negotiatedEra,
            pluginFormProfile: profile(op),
          });
      },
    });
    return inner(args);
  };
  return {
    collector,
    async execute(
      authorization: ResolvedInvocationContext,
      invocationId: string,
      params: PluginToolCallParams,
      signal: AbortSignal,
      runOriginal?: () => Promise<unknown>,
    ) {
      if (
        !["app", "entrypoint", "quick-action", "model"].includes(
          authorization.origin,
        )
      )
        throw new PluginInvocationError("CONTINUATION_ORIGIN_UNSUPPORTED");
      if (operation) throw new PluginInvocationError("CONTINUATION_BUSY");
      operation = { authorization, invocationId, params, signal };
      captured = undefined;
      try {
        if (runOriginal) return await runOriginal();
        return await manager().executeTool(
          deps.serverId,
          params.name,
          params.arguments ?? {},
          {
            metadata: params._meta,
            request: { signal },
            retry: { retries: 0, retryDelayMs: 0 },
          },
        );
      } catch (error) {
        const suspended = readCaptured();
        if (
          !isMrtrSuspendedSignal(error) ||
          !suspended ||
          suspended.pending.continuationId !== error.continuationId ||
          suspended.pending.round !== error.round
        )
          throw error;
        let disabled = false;
        try {
          signal.throwIfAborted();
          await deps.assertCurrent();
          // A new form is never shown once Forms is off.
          if (formsOff()) {
            disabled = true;
            throw withPluginDiagnostic(
              new PluginInvocationError("PLUGIN_FORMS_DISABLED"),
              deps.serverId,
              "Form cancelled: Forms is turned off for this client",
            );
          }
          return bindSources(
            { authorization, invocationId, params, signal },
            suspended,
          );
        } catch (denied) {
          await cancelContinuation(deps.bearer, {
            continuationId: suspended.pending.continuationId,
            reason: disabled ? "plugin_forms_disabled" : "plugin_owner_changed",
          });
          throw denied;
        }
      } finally {
        operation = undefined;
        captured = undefined;
      }
    },
    async resume(
      authorization: ResolvedInvocationContext,
      invocationId: string,
      params: PluginToolCallParams,
      submission: PluginContinuationSubmission,
      signal: AbortSignal,
    ) {
      const op: Operation = { authorization, invocationId, params, signal };
      const current = manager();
      await deps.assertCurrent();
      const formsDisabled = () =>
        endPluginMrtrFormsDisabled({
          bearer: deps.bearer,
          owner: authorization.owner,
          invocationId,
          continuationId: submission.continuationId,
          serverId: deps.serverId,
        });
      // The client's current Forms toggle decides delivery, not the one the
      // form was shown with.
      if (formsOff()) return formsDisabled();
      let turnedOff = false;
      const client = current.getManagedClient(deps.serverId);
      // No wire started: the answer can be resent once the server reconnects.
      if (!client)
        throw new PluginContinuationRefused(
          "CONTINUATION_CONNECTION_UNAVAILABLE",
        );
      let wireStarted = false;
      const result = await resumeMrtrContinuationLeg({
        bearer: deps.bearer,
        submission,
        schemaDisplayMaxBytes: PLUGIN_FORM_SCHEMA_MAX_BYTES,
        encode: (state) =>
          encodeResumeState(state, PLUGIN_MRTR_PRIVATE_STATE_MAX_BYTES),
        decode: (state) =>
          decodeResumeState(state, PLUGIN_MRTR_PRIVATE_STATE_MAX_BYTES),
        resuspend: (bearer, body, signal) =>
          resuspendContinuation(
            bearer,
            { ...body, privateResumeState: true },
            signal,
          ),
        bindingFingerprint: fingerprint(current, {
          authorization,
          invocationId,
          params,
          signal,
        }),
        prepareLeg: async (state, responses) => {
          signal.throwIfAborted();
          await deps.assertCurrent();
          if (formsOff()) {
            turnedOff = true;
            throw new PluginInvocationError("PLUGIN_FORMS_DISABLED");
          }
          if (
            state.method !== "tools/call" ||
            state.originalParams.name !== params.name ||
            JSON.stringify(state.originalParams.arguments ?? {}) !==
              JSON.stringify(params.arguments ?? {})
          )
            throw new PluginInvocationError("CONTINUATION_OPERATION_DENIED");
          validateRequests(state.pendingInputRequests, op);
          if (
            Object.keys(responses).length !==
            Object.keys(state.pendingInputRequests).length
          )
            throw new PluginInvocationError("CONTINUATION_FORM_UNSUPPORTED");
          const deliveries: ReturnType<
            typeof pluginFormFileGrants.prepareDelivery
          >[] = [];
          const sources: AbortSignal[] = [];
          const mapped = Object.fromEntries(
            Object.entries(state.pendingInputRequests).map(([key, request]) => {
              const requestedSchema = (
                request as { params?: { requestedSchema?: unknown } }
              ).params?.requestedSchema;
              const original = pluginFormSources.find(
                authorization.owner,
                invocationId,
                {
                  kind: "mrtr",
                  id: submission.continuationId,
                  round: submission.round,
                  inputRequestKey: key,
                },
              );
              sources.push(original.signal);
              if (
                original.source.hostRevision !==
                  deps.sourceBinding.hostRevision ||
                original.source.revision !== authorization.revision ||
                pluginBindingDigest(original.source.requestedSchema) !==
                  pluginBindingDigest(requestedSchema)
              )
                throw new PluginInvocationError("FORM_SOURCE_UNAVAILABLE");
              const answer = openAILegacyFormSchemas.result.parse(
                responses[key],
              );
              if (answer.action !== "accept") return [key, answer];
              if (
                !answer.content ||
                !validatePluginFormContent(
                  compilePluginForm(requestedSchema, profile(op)),
                  answer.content,
                ).valid
              )
                throw new PluginInvocationError(
                  "CONTINUATION_FORM_UNSUPPORTED",
                );
              if (!original.source.uploadTarget) return [key, answer];
              if (uploadTarget() !== original.source.uploadTarget)
                throw new PluginInvocationError("FORM_FILE_UNAVAILABLE");
              const delivery = pluginFormFileGrants.prepareDelivery(
                original.source,
                original.token,
                answer.content,
              );
              deliveries.push(delivery);
              return [key, { ...answer, content: delivery.content }];
            }),
          );
          return {
            responses: mapped,
            commit: () => {
              signal.throwIfAborted();
              for (const source of sources) source.throwIfAborted();
              for (const delivery of deliveries) delivery.assertReady();
              for (const delivery of deliveries) delivery.commit();
            },
          };
        },
        driveLeg: async (state, responses) => {
          pluginFormSources.closeRound(
            authorization.owner,
            invocationId,
            submission.continuationId,
            submission.round,
          );
          wireStarted = true;
          const leg = await resumeInputRequiredOperation(
            client,
            state,
            responses,
            {
              signal,
              requestOptions: { timeout: WEB_CALL_TIMEOUT_MS },
              supportedElicitationModes: ["form"],
              validateContent: (schema, content) =>
                validatePluginFormContent(
                  compilePluginForm(schema, profile(op)),
                  content,
                ),
            },
          );
          if (leg.status === "input_required")
            validateRequests(leg.state.pendingInputRequests, op);
          return leg;
        },
      });
      if (result.outcome === "completed") {
        pluginFormFileGrants.closeOperation(authorization.owner, invocationId);
        pluginFormSources.closeOperation(authorization.owner, invocationId);
        return result.result;
      }
      if (result.outcome === "input_required") {
        try {
          return bindSources(
            { authorization, invocationId, params, signal },
            new PluginInvocationSuspension({
              status: "input_required",
              version: HOSTED_MRTR_VERSION,
              continuationId: submission.continuationId,
              round: result.round,
              serverId: deps.serverId,
              method: "tools/call",
              operationLabel: params.name,
              inputRequests: result.displays,
              expiresAt: result.expiresAt,
              negotiatedEra: resolveMrtrNegotiatedEra(current, deps.serverId),
              pluginFormProfile: profile(op),
            }),
          );
        } catch (error) {
          pluginFormSources.closeOperation(authorization.owner, invocationId);
          await cancelContinuation(deps.bearer, {
            continuationId: submission.continuationId,
            reason: "plugin_form_source_unavailable",
          });
          throw error;
        }
      }
      // Forms went off during this leg's admission: nothing reached the wire.
      if (!wireStarted && turnedOff) return formsDisabled();
      if (!wireStarted && result.outcome === "failed")
        throw new PluginContinuationRefused();
      pluginFormSources.closeOperation(authorization.owner, invocationId);
      // An expired or cancelled form never reached the server again: the
      // outcome is known (the call did not complete), not uncertain.
      if (
        !wireStarted &&
        (result.outcome === "expired" ||
          // Only an already-terminal record, never a contended lease (409).
          (result.outcome === "cancelled" &&
            result.reason === "continuation already cancelled"))
      )
        throw new PluginContinuationTerminal(
          result.outcome === "expired"
            ? "CONTINUATION_EXPIRED"
            : "CONTINUATION_CANCELLED",
        );
      throw new PluginInvocationError("INVOCATION_OUTCOME_UNKNOWN", true);
    },
  };
}
