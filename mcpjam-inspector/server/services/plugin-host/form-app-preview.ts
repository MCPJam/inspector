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
import { PLUGIN_APP_UI_MAX_BYTES } from "../../../shared/plugin-app-ui-limits.js";
import type { PluginInstanceIdentity } from "./instances.js";
import {
  createPluginInstanceControlPort,
  pluginInstanceIdentityHash,
} from "./instance-store.js";
import { pluginReceiptHash } from "./receipt-store.js";
import {
  formPreviewHandles,
  readFormPreview,
  storeFormPreview,
} from "./form-preview-control.js";

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
/** This process's children, by caller and handle: a handle alone never
 * finds another identity's child. The stored row is the authority. */
const children = new Map<string, Child>();
const childKey = (actor: PluginInstanceIdentity, token: string) =>
  pluginReceiptHash([pluginInstanceIdentityHash(actor), token]);
const port = (actor: PluginInstanceIdentity) => {
  const value = createPluginInstanceControlPort(actor);
  if (!value) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
  return value;
};
function keepChild(
  actor: PluginInstanceIdentity,
  token: string,
  fields: Omit<Child, "token" | "invoker">,
  owner: ConstructorParameters<typeof RequestOwnedToolInvoker>[0],
  sourceSignal: AbortSignal,
) {
  const key = childKey(actor, token);
  const existing = children.get(key);
  if (existing) return existing;
  if (
    children.size >= 128 ||
    [...children.values()].filter(
      (value) => value.sourceToken === fields.sourceToken,
    ).length >= 8
  )
    throw new PluginInvocationError("FORM_PREVIEW_LIMIT");
  const caller = structuredClone(actor);
  const parent = structuredClone(fields.parent);
  const child: Child = {
    ...fields,
    token,
    invoker: new RequestOwnedToolInvoker(owner, () => {
      pluginFormSources.get(fields.sourceToken, caller, parent);
    }),
  };
  children.set(key, child);
  sourceSignal.addEventListener(
    "abort",
    () => {
      if (children.get(key) === child) children.delete(key);
      child.invoker.close();
    },
    { once: true },
  );
  return child;
}

/** A source owns the child and receipt; hiding a view never creates another effect. */
export async function openPluginFormAppPreview(
  options: PluginFormPreviewServiceOptions,
) {
  if (options.target.type !== "mcp_app_tool") return refuse();
  const service = await createPluginFormService(options);
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
      Buffer.byteLength(widgetContent.html, "utf8") > PLUGIN_APP_UI_MAX_BYTES
    )
      return refuse();
    const fresh = (await service.authorizeTools([options.target.name])).get(
      options.target.name,
    )!;
    if (fresh.revision !== resolved.revision) return refuse();
    service.assertLive();
    const binding = pluginBindingDigest([fresh.revision, uri]);
    const handles = formPreviewHandles(
      options.actor,
      options.sourceToken,
      options.target,
    );
    const known = children.get(childKey(options.actor, handles.token));
    if (known && known.binding !== binding) return refuse();
    const fields = {
      sourceToken: options.sourceToken,
      parent: structuredClone(options.parent),
      target: structuredClone(options.target),
      binding,
      operationId: handles.operationId,
      viewId: handles.viewId,
    };
    // Stored before the handle reaches the browser, so any replica can
    // serve the child's calls; a reopen anywhere stores the same bytes.
    if (!known)
      await storeFormPreview(
        port(options.actor),
        handles.token,
        options.actor,
        {
          sourceToken: fields.sourceToken,
          parent: fields.parent,
          target: fields.target,
          binding,
          expiresAt: service.source.expiresAt,
        },
        service.signal,
      );
    const child = keepChild(
      options.actor,
      handles.token,
      fields,
      service.source.owner,
      service.sourceSignal,
    );
    service.assertLive();
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
export async function getPluginFormApp(
  options: Omit<
    PluginFormPreviewServiceOptions,
    "target" | "sourceToken" | "parent"
  > & { token: string },
) {
  const held = children.get(childKey(options.actor, options.token));
  const stored =
    held ?? (await readFormPreview(port(options.actor), options.token, options.signal));
  if (stored.target.type !== "mcp_app_tool") return refuse();
  // A child outlives nothing: once its form is gone, so is the preview.
  const service = await createPluginFormService({
    ...options,
    sourceToken: stored.sourceToken,
    parent: stored.parent,
    target: stored.target,
  }).catch((error: unknown) => {
    if (
      error instanceof PluginInvocationError &&
      error.code === "FORM_SOURCE_UNAVAILABLE"
    )
      throw refuse();
    throw error;
  });
  const handles = formPreviewHandles(
    options.actor,
    stored.sourceToken,
    stored.target,
  );
  // A handle is only ever the one derived for this caller's own form.
  if (handles.token !== options.token) return refuse();
  const child = keepChild(
    options.actor,
    options.token,
    {
      sourceToken: stored.sourceToken,
      parent: stored.parent,
      target: stored.target,
      binding: stored.binding,
      operationId: handles.operationId,
      viewId: handles.viewId,
    },
    service.source.owner,
    service.sourceSignal,
  );
  const target = stored.target;
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
