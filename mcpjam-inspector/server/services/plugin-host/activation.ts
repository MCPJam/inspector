import {
  pluginEntrypointPlan,
  type PluginEntrypointSelector,
} from "../../../shared/plugin-activation.js";
import {
  pluginBindingDigest,
  pluginOptionalResourceUri,
  pluginResourceUri,
} from "./bindings.js";
import {
  resolvePluginCatalogTool,
  type createPluginRequestRuntime,
} from "./request-runtime.js";
import { pluginToolCallValidation } from "./tool-call-validation.js";
import { PluginInvocationError } from "./invocation.js";
import type { PluginInstanceAdmissionRead } from "./instances.js";

/** Source and target come from one freshly authorized catalog on the same server. */
export async function resolvePluginActivation(
  runtime: Pick<ReturnType<typeof createPluginRequestRuntime>, "catalog">,
  sourceName: string,
  selector: PluginEntrypointSelector,
  signal: AbortSignal,
  read?: PluginInstanceAdmissionRead,
) {
  return pluginActivationFromCatalog(
    await runtime.catalog(signal, read),
    sourceName,
    selector,
  );
}

/**
 * Re-resolve an OPEN App's activation from a freshly admitted catalog, so the
 * result's `revision` compares with the one stored when it opened. A quick
 * action's revision binds its source tool, its target tool and the planned
 * call (`pluginActivationFromCatalog`); every other kind binds its own tool.
 * Comparing a quick action's target-tool revision with it never matches, so
 * its context, removal and messages (and every chat turn that carried its
 * context) were refused.
 */
export function resolveOpenPluginActivation(
  runtime: Pick<
    ReturnType<typeof createPluginRequestRuntime>,
    "catalog" | "resolve"
  >,
  activation: {
    selector?: { kind: string };
    toolName: string;
    sourceToolName?: string;
  },
  signal: AbortSignal,
) {
  return activation.selector?.kind === "quick-action" &&
    activation.sourceToolName
    ? resolvePluginActivation(
        runtime,
        activation.sourceToolName,
        activation.selector as PluginEntrypointSelector,
        signal,
      )
    : runtime.resolve(activation.toolName, signal);
}

/** The same plan from a catalog this request already admitted. */
export function pluginActivationFromCatalog(
  catalog: Awaited<
    ReturnType<ReturnType<typeof createPluginRequestRuntime>["catalog"]>
  >,
  sourceName: string,
  selector: PluginEntrypointSelector,
) {
  const source = resolvePluginCatalogTool(catalog, sourceName);
  const plan = pluginEntrypointPlan(source.tool, selector);
  const target = resolvePluginCatalogTool(catalog, plan.params.name);
  pluginToolCallValidation(
    target.tool,
    plan.params.arguments,
    () => new PluginInvocationError("ACTIVATION_SCHEMA_INVALID"),
  );
  const sourceUri = pluginResourceUri(source.tool._meta);
  const targetUri = pluginOptionalResourceUri(target.tool._meta);
  return {
    ...target,
    revision: pluginBindingDigest([
      source.revision,
      target.revision,
      plan.params,
    ]),
    /** The target tool's own revision, as `runtime.resolve(target)` reports it. */
    toolRevision: target.revision,
    source,
    plan,
    resource: targetUri ? target : source,
    resourceUri: targetUri ?? sourceUri,
    presentation: targetUri ? ("app" as const) : ("result" as const),
  };
}
