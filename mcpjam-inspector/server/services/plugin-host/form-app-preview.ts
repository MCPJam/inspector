import { randomBytes, randomUUID } from "node:crypto";
import { waitForPluginOperation } from "../../../shared/plugin-operation.js";
import { pluginBindingDigest, pluginResourceUri } from "./bindings.js";
import { PluginInvocationError } from "./invocation.js";
import { RequestOwnedToolInvoker } from "./request-invoker.js";
import { pluginFormSources } from "./form-sources.js";
import {
  createPluginFormService,
  type PluginFormPreviewServiceOptions,
} from "./form-service.js";
import { pluginToolCallValidation } from "./tool-call-validation.js";
import { widgetResourceContent } from "../../utils/widget-resource-content.js";
import {
  canSkipListingLookup,
  findListingMetaForUri,
} from "../../utils/ui-resource-meta.js";
import { viewOriginLabelForConfig } from "../../utils/view-origin-label.js";

const refuse = (): never => {
  throw new PluginInvocationError("FORM_PREVIEW_UNAVAILABLE");
};
interface Child {
  token: string;
  sourceToken: string;
  target: PluginFormPreviewServiceOptions["target"];
  parent: PluginFormPreviewServiceOptions["parent"];
  binding: string;
  operationId: string;
  viewId: string;
  invoker: RequestOwnedToolInvoker;
}
const children = new Map<string, Child>();
const identities = new Map<string, string>();

/** A source owns the child and receipt; hiding a view never creates another effect. */
export async function openPluginFormAppPreview(
  options: PluginFormPreviewServiceOptions,
) {
  if (options.target.type !== "mcp_app_tool") return refuse();
  const service = createPluginFormService(options);
  try {
    const tools = await service.authorizeTools([options.target.name]);
    const resolved = tools.get(options.target.name)!;
    pluginToolCallValidation(
      resolved.tool,
      options.target.arguments ?? {},
      refuse,
    );
    const uri = pluginResourceUri(resolved.tool._meta);
    const resource = await waitForPluginOperation(service.signal, () =>
      resolved.manager.readResource(
        service.source.owner.serverId,
        { uri },
        { signal: service.signal },
      ),
    );
    const content = resource.contents[0];
    if (!content || content.uri !== uri) return refuse();
    const listingMeta = canSkipListingLookup(content._meta)
      ? undefined
      : await waitForPluginOperation(service.signal, () =>
          findListingMetaForUri(
            resolved.manager,
            service.source.owner.serverId,
            uri,
          ),
        );
    const widgetContent = {
      ...widgetResourceContent(content, listingMeta),
      permissive: false,
      injectedOpenAiCompat: false,
      viewOriginLabel: viewOriginLabelForConfig(
        resolved.manager.getServerConfig(service.source.owner.serverId),
      ),
    };
    if (
      !widgetContent.mimeTypeValid ||
      Buffer.byteLength(widgetContent.html, "utf8") > 1024 * 1024
    )
      return refuse();
    const fresh = (await service.authorizeTools([options.target.name])).get(
      options.target.name,
    )!;
    if (fresh.revision !== resolved.revision) return refuse();
    service.assertLive();
    const key = pluginBindingDigest([options.sourceToken, options.target]);
    const binding = pluginBindingDigest([fresh.revision, uri]);
    let child = children.get(identities.get(key) ?? "");
    if (child && child.binding !== binding) return refuse();
    if (!child) {
      if (
        children.size >= 128 ||
        [...children.values()].filter(
          (value) => value.sourceToken === options.sourceToken,
        ).length >= 8
      )
        throw new PluginInvocationError("FORM_PREVIEW_LIMIT");
      const actor = structuredClone(options.actor);
      const parent = structuredClone(options.parent);
      const sourceToken = options.sourceToken;
      const assertLive = () => {
        pluginFormSources.get(sourceToken, actor, parent);
      };
      const token = randomBytes(32).toString("base64url");
      child = {
        token,
        sourceToken,
        parent,
        target: structuredClone(options.target),
        binding,
        operationId: randomUUID(),
        viewId: randomUUID(),
        invoker: new RequestOwnedToolInvoker(service.source.owner, assertLive),
      };
      children.set(token, child);
      identities.set(key, token);
      const invoker = child.invoker;
      service.sourceSignal.addEventListener(
        "abort",
        () => {
          children.delete(token);
          identities.delete(key);
          invoker.close();
        },
        { once: true },
      );
      assertLive();
    }
    return {
      instanceToken: child.token,
      instanceId: child.viewId,
      generation: 1,
      operationId: child.operationId,
      resourceUri: uri,
      toolTitle: resolved.tool.title ?? resolved.tool.name,
      toolMetadata: resolved.tool._meta,
      appToolsEnabled: resolved.appToolsEnabled,
      widgetContent,
      serverId: service.source.owner.serverId,
      toolName: options.target.name,
    };
  } finally {
    await service.runtime.release();
  }
}

/** Re-establish original source/actor/pending authority for every child request. */
export function getPluginFormApp(
  options: Omit<
    PluginFormPreviewServiceOptions,
    "target" | "sourceToken" | "parent"
  > & { token: string },
) {
  const child = children.get(options.token);
  if (!child || child.target.type !== "mcp_app_tool") return refuse();
  const service = createPluginFormService({
    ...options,
    sourceToken: child.sourceToken,
    parent: child.parent,
    target: child.target,
  });
  const target = child.target;
  const resolve = async (name: string, _signal: AbortSignal) => {
    const tools = await service.authorizeTools([target.name, name]);
    const initial = tools.get(target.name)!;
    if (
      pluginBindingDigest([
        initial.revision,
        pluginResourceUri(initial.tool._meta),
      ]) !== child.binding
    )
      return refuse();
    service.assertLive();
    return tools.get(name)!;
  };
  return { child, service, target, resolve };
}
