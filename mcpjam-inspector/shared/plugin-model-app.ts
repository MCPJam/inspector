import { z } from "zod";
export const PLUGIN_MODEL_APP_META = "mcpjam/model-app";
export const pluginModelAppSchema = z.strictObject({
  instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  projectId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  hostId: z.string().min(1).max(256),
  serverId: z.string().min(1).max(256),
});
export type PluginModelApp = z.infer<typeof pluginModelAppSchema>;

/** Host controls never become guest metadata. Preserve all ordinary result data. */
export function withoutModelAppControl(value: unknown): unknown {
  const strip = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    const result = value as Record<string, unknown>;
    const meta = result._meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return value;
    const { [PLUGIN_MODEL_APP_META]: _control, ...rest } = meta as Record<
      string,
      unknown
    >;
    return { ...result, _meta: rest };
  };
  const outer = strip(value);
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return outer;
  const record = outer as Record<string, unknown>;
  return Object.hasOwn(record, "value")
    ? { ...record, value: strip(record.value) }
    : outer;
}
