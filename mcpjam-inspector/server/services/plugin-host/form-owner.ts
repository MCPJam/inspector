import type { PluginFormOwnerRef } from "./form-source-control.js";
import { readAfterAdmission } from "./durable-controls.js";
import { pluginInstances, type PluginInstanceIdentity } from "./instances.js";
import {
  PluginInvocationError,
  type TrustedInvocationOwner,
} from "./invocation.js";
import { modelApps } from "./model-apps.js";
import { pluginModelForms } from "./model-form-control.js";

/**
 * Read a form's owner from the store and restore it into this process, so
 * `pluginInstances.getFormOwner` finds it on any replica. Every call reads
 * the stored row: a close or expiry on another replica refuses here.
 */
export async function restorePluginFormOwner(
  ref: PluginFormOwnerRef,
  identity: PluginInstanceIdentity,
  signal: AbortSignal,
) {
  try {
    await restoreOwner(ref, identity, signal);
  } catch (error) {
    // On a form, an unreachable store is the form's to report.
    if (
      error instanceof PluginInvocationError &&
      error.code === "INSTANCE_STORE_UNAVAILABLE"
    )
      throw new PluginInvocationError("FORM_STORE_UNAVAILABLE");
    throw error;
  }
}

async function restoreOwner(
  ref: PluginFormOwnerRef,
  identity: PluginInstanceIdentity,
  signal: AbortSignal,
) {
  if (ref.kind === "app") {
    await pluginInstances.getPersistent(ref.token, identity, signal);
    return;
  }
  if (ref.kind === "model-app") {
    await modelApps.restore(ref.token, identity, signal);
    return;
  }
  await pluginModelForms.restore(ref.token, identity, signal);
}

/**
 * Every form step's owner check: this process's copy, the admission read,
 * then the owner's stored row (never beside it), then the copy again. Without
 * `ownerRef`, or with `fenceOwner` false for a model call whose row is not
 * written yet, the owner lives only in this process and its copy decides.
 */
export async function assertPluginFormOwnerCurrent<T>(input: {
  owner: TrustedInvocationOwner;
  identity: PluginInstanceIdentity;
  ownerRef?: PluginFormOwnerRef;
  fenceOwner?: boolean;
  admit: () => Promise<T>;
  signal: AbortSignal;
}) {
  pluginInstances.getFormOwner(input.owner, input.identity);
  const admitted = await readAfterAdmission(input.admit, async () => {
    if (input.ownerRef && input.fenceOwner !== false)
      await restorePluginFormOwner(input.ownerRef, input.identity, input.signal);
  });
  input.signal.throwIfAborted();
  pluginInstances.getFormOwner(input.owner, input.identity);
  return admitted;
}
