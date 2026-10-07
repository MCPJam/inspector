import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { PluginInvocationError } from "./invocation.js";
import { timedPluginStep } from "./timing.js";
import { localPluginControls, pluginLocalStoresEnabled } from "./local-store.js";
import { getServiceCredential } from "../service-credential.js";
import {
  INVOCATION_RECEIPT_PATH,
  PLUGIN_INSTANCE_CONTROL_PATH,
} from "../../../shared/plugin-invocation-receipts.js";

const spanFor = (path: string) =>
  path.includes("plugin-instance-controls")
    ? "control-store"
    : path.includes("plugin-invocations")
      ? "receipt-store"
      : "service-store";

/**
 * The backend's Inspector-service query and mutation for each private store.
 * They take the same commands as the store's HTTP route, behind the same
 * service credential, and answer with the same values and refusal codes; a
 * call costs one Convex client round trip instead of an HTTP action (about
 * 80 ms against 500 ms). Reads go to the query, everything else to the
 * mutation, exactly as the route dispatches them.
 */
const FAST_STORES: Readonly<
  Record<string, { module: string; span: string; reads: ReadonlySet<string> }>
> = {
  [PLUGIN_INSTANCE_CONTROL_PATH]: {
    module: "pluginInstanceControls",
    span: "control-fast",
    reads: new Set([
      "read",
      "read-activation",
      "read-child",
      "list-models",
      "list-contexts",
    ]),
  },
  [INVOCATION_RECEIPT_PATH]: {
    module: "pluginInvocationReceipts",
    span: "receipt-fast",
    reads: new Set(["read"]),
  },
};
/** Convex's answer for a function the deployment does not have yet. Nothing
 * ran, so the same command may go to the HTTP route instead. */
const MISSING_FUNCTION = /Could not find public function for '/;
/** How long a deployment without the fast functions is not asked again. A
 * backend deployed later is picked up within this window, with no restart. */
export const PLUGIN_FAST_STORE_RETRY_MS = 5 * 60_000;
const missingUntil = new Map<string, number>();
/** The Convex response envelope around the value (status, log lines). */
const ENVELOPE_BYTES = 4096;
const MISSING = Symbol("missing-function");

/** Test seam: forget which deployments lacked the fast functions. */
export function resetPluginFastStoreDetection() {
  missingUntil.clear();
}

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
  const token = getServiceCredential(env);
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
  const refusal = (data: { code?: unknown } | null | undefined) =>
    new PluginInvocationError(
      typeof data?.code === "string" && /^[A-Z0-9_]{1,96}$/.test(data.code)
        ? data.code
        : unavailable,
    );
  /** Read a reply body, refusing one larger than `limit` bytes. */
  const readCapped = async (reply: Response, limit: number) => {
    const reader = reply.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) {
            await reader.cancel();
            throw new Error("service response too large");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    return Buffer.concat(chunks);
  };
  const sendHttp = async (body: unknown, signal: AbortSignal): Promise<any> => {
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
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readCapped(reply, responseBytes),
        ),
      );
      if (!reply.ok) throw refusal(data);
      bounded.throwIfAborted();
      return data;
    } catch (error) {
      if (error instanceof PluginInvocationError) throw error;
      throw new PluginInvocationError(unavailable);
    }
  };

  const fast = FAST_STORES[path];
  const convexUrl = env.CONVEX_URL?.trim();
  /** A client for one call: its fetch carries that call's deadline and the
   * HTTP route's response bound. No user bearer is ever set on it; the
   * service credential is the only authority it presents. */
  const clientFor = (deadline?: AbortSignal) =>
    new ConvexHttpClient(convexUrl!, {
      logger: false,
      fetch: async (input, init) => {
        const reply = await fetchImpl(input, {
          ...init,
          redirect: "error",
          signal: deadline,
        });
        return new Response(
          await readCapped(reply, responseBytes + ENVELOPE_BYTES),
          { status: reply.status, headers: reply.headers },
        );
      },
    });
  let fastEnabled = !!fast && !!convexUrl;
  if (fastEnabled)
    try {
      clientFor();
    } catch {
      fastEnabled = false;
    }
  /** One command through the Convex client; MISSING when the deployment
   * predates the fast functions. */
  const sendFast = async (
    name: string,
    read: boolean,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const client = clientFor(deadline);
    try {
      const value = read
        ? await client.query(makeFunctionReference<"query">(name), {
            serviceToken: token,
            requestId: randomUUID(),
            command: body,
          })
        : await client.mutation(
            makeFunctionReference<"mutation">(name),
            { serviceToken: token, command: body },
            { skipQueue: true },
          );
      deadline.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > responseBytes)
        throw new Error("service response too large");
      return value;
    } catch (error) {
      // A function refusal carries its code (the HTTP route's 4xx body).
      if (
        error instanceof ConvexError ||
        (error as Error | undefined)?.name === "ConvexError"
      )
        throw refusal((error as { data?: { code?: unknown } }).data);
      if (
        !deadline.aborted &&
        MISSING_FUNCTION.test((error as Error | undefined)?.message ?? "")
      )
        return MISSING;
      throw new PluginInvocationError(unavailable);
    }
  };
  const send = async (body: unknown, signal: AbortSignal): Promise<any> => {
    if (fastEnabled) {
      const read = fast!.reads.has((body as { action?: string })?.action ?? "");
      const name = `${fast!.module}:${read ? "serviceRead" : "serviceApply"}`;
      const key = `${convexUrl}|${name}`;
      if ((missingUntil.get(key) ?? 0) <= Date.now()) {
        const value = await timedPluginStep(fast!.span, () =>
          sendFast(name, read, body, signal),
        );
        if (value !== MISSING) {
          missingUntil.delete(key);
          return value;
        }
        // An older backend: the command did not run. Use the HTTP route.
        missingUntil.set(key, Date.now() + PLUGIN_FAST_STORE_RETRY_MS);
      }
    }
    return timedPluginStep(span, () => sendHttp(body, signal));
  };
  return send;
}
