import {
  parsePluginSettingsSet,
  type PluginSettingsDocument,
} from "../../../shared/plugin-settings.js";
import type { SettingsOperationIntent } from "../../../shared/plugin-settings-operation.js";
import type { PluginPreviewInstance } from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import type { PluginOperation } from "./operation-authorization.js";

/** Bind authorization to the server-derived operation and the original settings child. */
export function settingsOperation(
  instance: PluginPreviewInstance,
  intent: SettingsOperationIntent,
  invocationId: string,
  document: PluginSettingsDocument | undefined,
): PluginOperation {
  const settings = instance.activation.settings;
  if (!settings || (intent.method !== "read" && !document))
    throw new PluginInvocationError("INSTANCE_DENIED");
  const params =
    intent.method === "app/call"
      ? intent.params
      : {
          name:
            intent.method === "read"
              ? settings.readTool
              : intent.method === "update"
                ? settings.updateTool
                : intent.toolName,
          arguments:
            intent.method === "update"
              ? parsePluginSettingsSet(document!.fields, { set: intent.set })
              : {},
        };
  if (!params.name) throw new PluginInvocationError("INSTANCE_DENIED");
  return {
    invocationId,
    origin: intent.method === "app/call" ? "app" : "settings",
    params: { ...params, name: params.name },
    source: {
      selector: instance.activation.selector,
      activationId:
        intent.method === "app/call"
          ? intent.childToken
          : instance.activation.operationId,
    },
  };
}
