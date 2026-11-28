import { z } from "zod";
import { pluginFormPreviewSchema } from "../../../shared/plugin-extensions/form-plan.js";
import { pluginFormParentSchema } from "../../../shared/plugin-form-services.js";
import type { DurablePluginInstanceControl } from "../../../shared/plugin-invocation-receipts.js";
import { pluginBindingDigest } from "./bindings.js";
import { pluginControlOwnerHash } from "./form-source-control.js";
import type { PluginInstanceIdentity } from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import {
  pluginInstanceIdentityHash,
  type PluginInstanceControlPort,
} from "./instance-store.js";
import { pluginReceiptHash } from "./receipt-store.js";

const refuse = () => new PluginInvocationError("FORM_PREVIEW_UNAVAILABLE");
/** An App preview opened inside a form, in the form every replica restores. */
const formPreviewControlSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("form-preview"),
  expiresAt: z.number().int().positive(),
  sourceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  parent: pluginFormParentSchema,
  target: pluginFormPreviewSchema,
  binding: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StoredFormPreview = z.infer<typeof formPreviewControlSchema>;

/**
 * The preview child's handle, operation and view, derived from the form's
 * random source token and the declared target. The same preview reopened in
 * the same form maps to the same child on any replica, so its calls share
 * one receipt. Another form, round or input has another source token.
 */
export function formPreviewHandles(
  identity: PluginInstanceIdentity,
  sourceToken: string,
  target: unknown,
) {
  const base = pluginReceiptHash([
    "plugin-handle-v1",
    "form-preview",
    pluginInstanceIdentityHash(identity),
    sourceToken,
    pluginBindingDigest(target),
  ]);
  const uuid = (label: string) => {
    const hex = pluginReceiptHash([base, label]);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return {
    token: Buffer.from(base, "hex").toString("base64url"),
    operationId: uuid("operation"),
    viewId: uuid("view"),
  };
}

/** Store the child before its handle reaches the browser. The row is the
 * same bytes on every replica, so a reopen stores nothing new. */
export async function storeFormPreview(
  port: PluginInstanceControlPort,
  token: string,
  identity: PluginInstanceIdentity,
  row: Omit<StoredFormPreview, "version" | "kind">,
  signal: AbortSignal,
) {
  const snapshotJson = JSON.stringify(
    formPreviewControlSchema.parse({ version: 1, kind: "form-preview", ...row }),
  );
  try {
    await port.issue(
      token,
      {
        snapshotJson,
        ownerHash: pluginControlOwnerHash("form-preview", identity, token),
        expiresAt: row.expiresAt,
      },
      signal,
    );
  } catch (error) {
    // Opened before with another tool revision or resource: not this child.
    if (
      error instanceof PluginInvocationError &&
      error.code === "INSTANCE_CONTROL_CHANGED"
    )
      throw refuse();
    throw error;
  }
}

/** The stored child for this caller, or a refusal. */
export async function readFormPreview(
  port: PluginInstanceControlPort,
  token: string,
  signal: AbortSignal,
) {
  let saved: DurablePluginInstanceControl | null;
  try {
    saved = await port.read(token, signal);
  } catch (error) {
    if (
      error instanceof PluginInvocationError &&
      ["INSTANCE_UNAVAILABLE", "INSTANCE_DENIED"].includes(error.code)
    )
      throw refuse();
    throw error;
  }
  if (!saved) throw refuse();
  try {
    const parsed = formPreviewControlSchema.safeParse(
      JSON.parse(saved.snapshotJson),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // A row that is not JSON is no preview.
  }
  throw refuse();
}
