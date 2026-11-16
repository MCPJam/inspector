import type { PluginFormOwnerRef } from "./form-source-control.js";
import { pluginInstances, type PluginInstanceIdentity } from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import { modelApps } from "./model-apps.js";

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
  await modelApps.restore(ref.token, identity, signal);
}

