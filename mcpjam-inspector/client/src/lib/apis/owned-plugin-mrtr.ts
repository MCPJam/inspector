import {
  isCompatibleMrtrVersion,
  type MrtrElicitationResponse,
} from "@/shared/mrtr-continuation";
import type { PluginFormProfile } from "@/shared/plugin-extensions/form-plan";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
import { createPrivateFormAnswer } from "./private-form-answer";
import {
  isHostedDirectMrtrPending,
  type HostedDirectMrtrPending,
  cancelHostedMrtrContinuation,
  acknowledgeHostedMrtrContinuation,
} from "./web/mrtr-api";

type Pending = HostedDirectMrtrPending & {
  pluginFormProfile: PluginFormProfile;
};
function ownedPending(value: unknown): value is Pending {
  if (!isHostedDirectMrtrPending(value)) return false;
  const profile = (value as Pending).pluginFormProfile;
  return (
    isCompatibleMrtrVersion(value.version) &&
    value.negotiatedEra === "2026-07-28" &&
    Number.isSafeInteger(value.round) &&
    value.round > 0 &&
    Number.isFinite(value.expiresAt) &&
    !!profile &&
    typeof profile.fileResources === "boolean" &&
    ["server", "mcp-app"].includes(profile.origin) &&
    (profile.userResources === false ||
      (profile.userResources === true &&
        Array.isArray(profile.userResourceKinds) &&
        profile.userResourceKinds.every(
          (kind) => kind === "file" || kind === "directory",
        ))) &&
    (profile.previews === false ||
      (profile.previews === true &&
        Array.isArray(profile.previewKinds) &&
        profile.previewKinds.length > 0 &&
        profile.previewKinds.every((kind) =>
          ["resource_link", "mcp_app_tool"].includes(kind),
        ))) &&
    value.inputRequests.every(
      (request) => request.mode === "form" && typeof request.key === "string",
    )
  );
}

/** Browser wait only. Every leg returns through the same instance invocation receipt. */
export async function driveOwnedPluginMrtr(
  value: unknown,
  options: {
    signal: AbortSignal;
    formScope?: { projectId: string; workspaceId: string };
    submit: (resume: {
      continuationId: string;
      round: number;
      responsesBlobId: string;
    }) => Promise<unknown>;
    cancel?: (continuationId: string) => Promise<unknown>;
    ack?: (continuationId: string) => Promise<unknown>;
  },
): Promise<unknown> {
  if (!isHostedDirectMrtrPending(value)) return value;
  const continuationId = value.continuationId;
  const withdraw = async () => {
    await (
      options.cancel ??
      ((id) =>
        cancelHostedMrtrContinuation({
          continuationId: id,
          reason: "plugin_owner_withdrew",
        }))
    )(continuationId).catch(() => {});
    // A cancel response can also be lost. ACK is actor-owned and terminal-only,
    // so it safely scrubs a confirmed or uncertain completed cancellation.
    await (options.ack ?? acknowledgeHostedMrtrContinuation)(
      continuationId,
    ).catch(() => {});
  };
  if (!ownedPending(value)) {
    await withdraw();
    throw new Error("Unsupported owned plugin input round");
  }
  let pending: Pending = value;
  try {
    for (;;) {
      options.signal.throwIfAborted();
      if (Date.now() >= pending.expiresAt)
        throw new Error("Plugin input round expired");
      const answer = createPrivateFormAnswer({
        kind: "mrtr",
        id: continuationId,
        round: pending.round,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      let outcome: unknown;
      try {
        outcome = await new Promise<unknown>((resolve, reject) => {
          abort = () => reject(new Error("Plugin input owner closed"));
          options.signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(
            () => reject(new Error("Plugin input round expired")),
            Math.max(1, pending.expiresAt - Date.now()),
          );
          const round = pending;
          useHostedMrtrStore.getState().enqueue(
            {
              key: `${continuationId}:${round.round}`,
              continuationId,
              round: round.round,
              serverId: round.serverId,
              method: round.method,
              operationLabel: round.operationLabel,
              requests: round.inputRequests,
              expiresAt: round.expiresAt,
              timestamp: new Date().toISOString(),
              pluginFormProfile: round.pluginFormProfile,
              pluginFormServiceScope: options.formScope,
            },
            {
              submit: async (
                responses: Record<string, MrtrElicitationResponse>,
              ) => {
                const responsesBlobId = await answer.prepare(responses);
                options.signal.throwIfAborted();
                const next = await options.submit({
                  continuationId,
                  round: round.round,
                  responsesBlobId,
                });
                options.signal.throwIfAborted();
                resolve(next);
              },
              cancel: async () => {
                reject(new Error("Plugin input round withdrawn"));
                await withdraw();
              },
            },
          );
        });
      } finally {
        answer.dispose();
        if (timer) clearTimeout(timer);
        if (abort) options.signal.removeEventListener("abort", abort);
      }
      if (!isHostedDirectMrtrPending(outcome)) {
        if (
          !outcome ||
          typeof outcome !== "object" ||
          (outcome as { status?: unknown }).status !== "completed" ||
          !Object.hasOwn(outcome, "result")
        )
          throw new Error("Invalid owned plugin continuation outcome");
        await (options.ack ?? acknowledgeHostedMrtrContinuation)(
          continuationId,
        ).catch(() => {});
        return outcome;
      }
      if (
        !ownedPending(outcome) ||
        outcome.continuationId !== continuationId ||
        outcome.round !== pending.round + 1 ||
        outcome.serverId !== pending.serverId
      )
        throw new Error("Invalid owned plugin continuation round");
      pending = outcome;
    }
  } catch (error) {
    await withdraw();
    throw error;
  } finally {
    useHostedMrtrStore.getState().resolveContinuation(continuationId);
  }
}
