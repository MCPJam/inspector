import { z } from "zod";
import {
  OpenAIFileEntrypointInputSchema,
  type OpenAIFileEntrypointInput,
} from "@openai/mcp-extensions/server";
import {
  OpenAIFileOpenParamsSchema,
  OpenAIResourceReadMetadataSchema,
  OpenAIResourceWriteParamsSchema,
  OpenAIResourceWriteResultSchema,
} from "@openai/mcp-extensions/app";
import {
  PluginActivationError,
  pluginFileEntrypoints,
  type PluginEntrypointTool,
} from "./plugin-activation.js";

/** Saved read-only file policy. This never supplies a resource grant or handler. */
export function pluginFileEntrypointsEnabled(profile: unknown): boolean {
  const value = profile as
    | {
        profileVersion?: unknown;
        extensions?: Record<string, unknown>;
        apps?: { mcpAppsOverrides?: { serverResources?: unknown } };
      }
    | undefined;
  return (
    value?.profileVersion === 1 &&
    value.extensions?.["mcpjam/plugin-file-entrypoints"] === true &&
    value.apps?.mcpAppsOverrides?.serverResources === true
  );
}

/** A host-produced descriptor, never a filename or path selected by the guest. */
export function parsePluginFileInput(
  value: unknown,
): OpenAIFileEntrypointInput {
  const input = OpenAIFileEntrypointInputSchema.parse(value);
  if (
    input.file.name.length > 255 ||
    !input.file.name.trim() ||
    /[/\\\u0000-\u001f]/u.test(input.file.name) ||
    input.file.name === "." ||
    input.file.name === ".." ||
    !/^host-resource:\/\/[A-Za-z0-9_-]{1,128}$/.test(input.file.resourceUri)
  )
    throw new PluginActivationError("PLUGIN_FILE_INPUT_INVALID");
  return input;
}

/** A file matches a declared extension case-insensitively, like HTML
 * `accept`: `PART.STL` opens a `.stl` viewer. Literal suffix only; no MIME
 * guessing or path resolution. */
export function pluginFileNameMatchesExtension(
  name: string,
  extension: string,
) {
  return name.toLowerCase().endsWith(extension.toLowerCase());
}

/** File inputs use the same declaration registry and official wire schema. */
export function pluginFileEntrypointPlan(
  tool: PluginEntrypointTool,
  value: unknown,
) {
  const input = parsePluginFileInput(value);
  const declared = pluginFileEntrypoints([tool])[0];
  if (
    !declared?.extensions.some((extension) =>
      pluginFileNameMatchesExtension(input.file.name, extension),
    )
  )
    throw new PluginActivationError("PLUGIN_FILE_ENTRYPOINT_UNAVAILABLE");
  return {
    params: { name: tool.name, arguments: input },
    scope: { kind: "global" as const },
  };
}

const readParams = z.strictObject({
  uri: z.string().min(1).max(512),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

/** Preserve supported metadata at the bridge; interpret only the reserved key. */
export function parsePluginFileRead(value: unknown) {
  const params = readParams.parse(value);
  const metadata = OpenAIResourceReadMetadataSchema.parse(params._meta ?? {});
  return {
    uri: params.uri,
    representation: metadata["openai/resource"]?.representation,
  };
}

export const pluginFileSubscriptionParamsSchema = z.strictObject({
  uri: z.string().min(1).max(512),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

// Request metadata is transport data, never a resource or target authority.
export const pluginFileWriteParamsSchema = z
  .strictObject({
    uri: z.string().min(1).max(512),
    ifMatch: z.string().min(1).max(512).optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .transform(({ _meta, ...content }) =>
    OpenAIResourceWriteParamsSchema.parse(content),
  );

export const parsePluginFileWriteResult = (value: unknown) =>
  OpenAIResourceWriteResultSchema.parse(value);

/** Guest paths are requests on the existing target, never target authority. */
export const pluginFileOpenParamsSchema = OpenAIFileOpenParamsSchema.refine(
  ({ path }) =>
    path.startsWith("/") &&
    path.length <= 4096 &&
    !/[\u0000-\u001f]/u.test(path),
  "An absolute execution-host path is required",
);

/** Explicit partial-prototype opt-in; separate from resource read permission. */
export function pluginFileOpenEnabled(profile?: {
  profileVersion?: number;
  extensions?: Record<string, unknown>;
}) {
  return (
    profile?.profileVersion === 1 &&
    profile.extensions?.["mcpjam/plugin-files-open"] === true
  );
}
