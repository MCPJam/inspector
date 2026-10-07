import { PluginInvocationError } from "./invocation.js";
import { timedPluginStep } from "./timing.js";
import { localPluginControls, pluginLocalStoresEnabled } from "./local-store.js";
import { PLUGIN_INSTANCE_CONTROL_PATH } from "../../../shared/plugin-invocation-receipts.js";

const spanFor = (path: string) =>
  path.includes("plugin-instance-controls")
    ? "control-store"
    : path.includes("plugin-invocations")
      ? "receipt-store"
      : "service-store";

export type PluginServiceStoreOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Overrides the deployment mode (tests). */
  hosted?: boolean;
};
/** Fresh private service port. Never retain it in a registry, snapshot or receipt. */
export function createPluginServiceStore(
  path: string,
  responseBytes: number,
  unavailable: string,
  options: PluginServiceStoreOptions = {},
) {
  const env = options.env ?? process.env;
  const token = env.INSPECTOR_SERVICE_TOKEN?.trim();
  if (!token) {
    // A single-user local install has no service token: keep App instance
    // controls in this process (D2). Receipts stay with the live invoker, and
    // hosted deployments still fail closed.
    if (
      path !== PLUGIN_INSTANCE_CONTROL_PATH ||
      !pluginLocalStoresEnabled(env, options.hosted)
    )
      return undefined;
    const local = localPluginControls.handler(path, unavailable);
    return (body: unknown, signal: AbortSignal): Promise<any> =>
      timedPluginStep("control-store", () => local(body, signal));
  }
  const base = env.CONVEX_HTTP_URL?.trim();
  if (!base) throw new PluginInvocationError(unavailable);
  const url = new URL(path, base).href;
  const fetchImpl = options.fetchImpl ?? fetch;
  const span = spanFor(path);
  const send = async (body: unknown, signal: AbortSignal): Promise<any> => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      const reply = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: bounded,
        headers: {
          "content-type": "application/json",
          "x-inspector-service-token": token,
        },
        body: JSON.stringify(body),
      });
      const reader = reply.body?.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > responseBytes) {
              await reader.cancel();
              throw new Error("service response too large");
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!reply.ok)
        throw new PluginInvocationError(
          typeof data.code === "string" && /^[A-Z0-9_]{1,96}$/.test(data.code)
            ? data.code
            : unavailable,
        );
      bounded.throwIfAborted();
      return data;
    } catch (error) {
      if (error instanceof PluginInvocationError) throw error;
      throw new PluginInvocationError(unavailable);
    }
  };
  return (body: unknown, signal: AbortSignal): Promise<any> =>
    timedPluginStep(span, () => send(body, signal));
}
