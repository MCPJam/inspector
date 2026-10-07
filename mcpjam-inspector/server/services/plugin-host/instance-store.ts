import type { PluginInstanceIdentity } from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import { pluginReceiptHash } from "./receipt-store.js";
import {
  createPluginServiceStore,
  type PluginServiceStoreOptions,
} from "./service-store.js";
import {
  PLUGIN_INSTANCE_CONTROL_PATH,
  PLUGIN_INSTANCE_CONTROL_HTTP_BYTES,
  type DurablePluginInstanceControl,
} from "../../../shared/plugin-invocation-receipts.js";

export interface PluginInstanceControlPort {
  read(
    token: string,
    signal: AbortSignal,
  ): Promise<DurablePluginInstanceControl | null>;
  issue(
    token: string,
    input: {
      snapshotJson: string;
      ownerHash: string;
      expiresAt: number;
      contextToken?: string;
      modelToken?: string;
      modelThreadHash?: string;
      settings?: boolean;
    },
    signal: AbortSignal,
  ): Promise<DurablePluginInstanceControl>;
  readActivation?(
    anchor: string,
    bindingHash: string,
    signal: AbortSignal,
  ): Promise<{ token: string; control: DurablePluginInstanceControl } | null>;
  issueActivation?(
    token: string,
    input: {
      anchor: string;
      bindingHash: string;
      renewable: boolean;
      snapshotJson: string;
      ownerHash: string;
      expiresAt: number;
      contextToken?: string;
    },
    signal: AbortSignal,
  ): Promise<{ token: string; control: DurablePluginInstanceControl }>;
  markNavigation?(
    token: string,
    signal: AbortSignal,
  ): Promise<DurablePluginInstanceControl>;
  /** Extend a live root activation's lease to `expiresAt` (never shorten it).
   * Keeps the same control, owner hash and snapshot. */
  renew?(
    token: string,
    input: { expiresAt: number },
    signal: AbortSignal,
  ): Promise<DurablePluginInstanceControl>;
  close(
    token: string,
    signal: AbortSignal,
    reserveUnknown?: boolean,
  ): Promise<void | { ownerHash: string }>;
  contexts?(signal: AbortSignal): Promise<string[]>;
  models?(threadId: string, signal: AbortSignal): Promise<string[]>;
  writeContext?(
    token: string,
    input: { expectedVersion: number; contextJson: string },
    signal: AbortSignal,
  ): Promise<DurablePluginInstanceControl>;
  writeSettings?(
    token: string,
    input: { expectedVersion: number; settingsJson: string },
    signal: AbortSignal,
  ): Promise<DurablePluginInstanceControl>;
}
export const pluginInstanceIdentityHash = (identity: PluginInstanceIdentity) =>
  pluginReceiptHash([
    "plugin-instance-control-v1",
    identity.actorId,
    identity.projectId,
    identity.workspaceId,
    identity.subject,
  ]);
export function createPluginInstanceControlPort(
  identity: PluginInstanceIdentity,
  options: PluginServiceStoreOptions = {},
): PluginInstanceControlPort | undefined {
  const request = createPluginServiceStore(
    PLUGIN_INSTANCE_CONTROL_PATH,
    PLUGIN_INSTANCE_CONTROL_HTTP_BYTES,
    "INSTANCE_STORE_UNAVAILABLE",
    options,
  );
  if (!request) return undefined;
  const identityHash = pluginInstanceIdentityHash(identity);
  const key = (token: string) => ({
    identityHash,
    controlHash: pluginReceiptHash([identityHash, token]),
  });
  const activationHash = (anchor: string) =>
    pluginReceiptHash([identityHash, "activation-v1", anchor]);
  const checkedActivation = (result: unknown) => {
    const value = result as {
      token: string;
      control: DurablePluginInstanceControl;
    } | null;
    if (
      !value ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
      typeof value.control?.snapshotJson !== "string" ||
      !Number.isSafeInteger(value.control.expiresAt)
    )
      throw new PluginInvocationError("INSTANCE_CONTROL_INVALID");
    return value;
  };
  return {
    readActivation: async (anchor, bindingHash, signal) => {
      const result = await request(
        {
          action: "read-activation",
          identityHash,
          activationAnchorHash: activationHash(anchor),
          activationBindingHash: bindingHash,
        },
        signal,
      );
      return result.activation === null
        ? null
        : checkedActivation(result.activation);
    },
    issueActivation: async (
      token,
      { anchor, bindingHash, renewable, ...input },
      signal,
    ) =>
      checkedActivation(
        await request(
          {
            action: "issue",
            ...key(token),
            ...input,
            activation: {
              token,
              anchorHash: activationHash(anchor),
              bindingHash,
              renewable,
            },
          },
          signal,
        ),
      ),
    markNavigation: async (token, signal) =>
      (await request({ action: "navigation", ...key(token) }, signal)).control,
    renew: async (token, input, signal) => {
      const control = (
        await request({ action: "renew", ...key(token), ...input }, signal)
      ).control as DurablePluginInstanceControl | undefined;
      if (
        typeof control?.snapshotJson !== "string" ||
        !Number.isSafeInteger(control.expiresAt)
      )
        throw new PluginInvocationError("INSTANCE_CONTROL_INVALID");
      return control;
    },
    writeSettings: async (token, input, signal) =>
      (await request({ action: "settings", ...key(token), ...input }, signal))
        .control,
    models: async (threadId, signal) =>
      (
        await request(
          {
            action: "list-models",
            identityHash,
            threadHash: pluginReceiptHash(["model-thread-v1", threadId]),
          },
          signal,
        )
      ).tokens,
    contexts: async (signal) =>
      (await request({ action: "list-contexts", identityHash }, signal)).tokens,
    writeContext: async (token, input, signal) =>
      (await request({ action: "context", ...key(token), ...input }, signal))
        .control,
    read: async (token, signal) =>
      (await request({ action: "read", ...key(token) }, signal)).control,
    issue: async (token, input, signal) =>
      (await request({ action: "issue", ...key(token), ...input }, signal))
        .control,
    close: async (token, signal, reserveUnknown = false) => {
      const result = await request(
        { action: "close", reserveUnknown, ...key(token) },
        signal,
      );
      if (result.closed !== true)
        throw new PluginInvocationError("INSTANCE_STORE_INVALID");
      // Private service-confirmed cleanup identity; never included in a public DTO.
      if (
        typeof result.ownerHash === "string" &&
        /^[0-9a-f]{64}$/.test(result.ownerHash)
      )
        return { ownerHash: result.ownerHash };
    },
  };
}
