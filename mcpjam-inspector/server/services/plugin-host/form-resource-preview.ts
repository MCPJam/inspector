import type { MCPClientManager } from "@mcpjam/sdk";
import type { PluginFormPreview } from "../../../shared/plugin-extensions/form-plan.js";
import { pluginFormResourcePreviewSchema } from "../../../shared/plugin-form-services.js";
import { PluginInvocationError } from "./invocation.js";
import { waitForPluginOperation } from "../../../shared/plugin-operation.js";
import {
  createPluginFormService,
  type PluginFormPreviewServiceOptions,
} from "./form-service.js";

/** Actual resources/read under the original operation's fresh saved authority. */
export async function readPluginFormResourcePreview(
  options: PluginFormPreviewServiceOptions,
) {
  if (options.target.type !== "resource_link")
    throw new PluginInvocationError("FORM_PREVIEW_UNAVAILABLE");
  const { source, signal, runtime, authorize } =
    createPluginFormService(options);
  try {
    return await readAuthorizedPluginFormResource({
      serverId: source.owner.serverId,
      target: options.target,
      signal,
      authorize,
    });
  } finally {
    await runtime.release();
  }
}

/** Bounded exact resource bytes. Admission stays with the actual original owner service. */
export async function readAuthorizedPluginFormResource(options: {
  serverId: string;
  target: PluginFormPreview;
  signal: AbortSignal;
  authorize: () => Promise<{ manager: Pick<MCPClientManager, "readResource"> }>;
}) {
  const { target, signal } = options;
  if (target.type !== "resource_link")
    throw new PluginInvocationError("FORM_PREVIEW_UNAVAILABLE");
  const { manager } = await waitForPluginOperation(signal, options.authorize);
  const result = await waitForPluginOperation(signal, () =>
    manager.readResource(options.serverId, { uri: target.uri }, { signal }),
  );
  const preview = pluginFormResourcePreviewSchema.parse({
    type: "resource",
    contents: result.contents.map((item) => ({
      uri: item.uri,
      mimeType: item.mimeType ?? "text/plain",
      ...("text" in item ? { text: item.text } : { blob: item.blob }),
    })),
  });
  if (preview.contents.some((item) => item.uri !== target.uri))
    throw new PluginInvocationError("FORM_PREVIEW_UNAVAILABLE");
  await waitForPluginOperation(signal, options.authorize);
  return preview;
}
