/**
 * Per-call shadow that puts the `io.modelcontextprotocol/tasks` eligibility
 * declaration onto exactly ONE `subscriptions/listen` request.
 *
 * ## Why a seam is needed at all
 *
 * SEP-2663 delivers optional `notifications/tasks` over a task-filtered
 * `subscriptions/listen`, and — like every other extension operation — that
 * listen request MUST carry the per-request eligibility declaration in
 * `params._meta["io.modelcontextprotocol/clientCapabilities"]`. A non-declaring
 * client gets `-32021`.
 *
 * `Client.listen(filter, options)` has no `_meta` parameter. It builds its own
 * request body (`client dist/index.mjs:3706-3713`):
 *
 * ```js
 * params: { _meta: { ...this._outboundMetaEnvelope() }, notifications: filter }
 * ```
 *
 * `RequestOptions` carries `signal` / `timeout` / progress and nothing that
 * reaches `params._meta`. So there is no public way to declare on a listen.
 *
 * ## Why the filter itself is fine
 *
 * Note what that same line does with the filter: `notifications: filter`,
 * verbatim. Upstream validates `SubscriptionFilterSchema` nowhere on the send
 * path, so the extension's `taskIds` member reaches the wire unmodified even
 * though upstream's own type does not know about it. Only `_meta` needs help.
 *
 * ## The shape of the fix
 *
 * The same discipline as `tasks-ext-era-gate.ts`: a narrowly scoped,
 * per-instance override of one private upstream member, installed for the
 * shortest possible window and removed immediately.
 *
 * The window can be made exact because `listen()`'s prologue is **fully
 * synchronous** up to and including the line above — transport check, era
 * check, promise wiring, `_listenState.set`, the ack timer, the abort listener,
 * then the request literal. The first `await` is the `transport.send` that
 * follows. So:
 *
 * ```ts
 * install();
 * const pending = client.listen(filter, options); // envelope read, synchronously
 * restore();                                       // nothing else can observe it
 * return await pending;
 * ```
 *
 * `restore()` runs in the same synchronous turn as the read, so no other
 * request — on this client or any other — can pick up the widened envelope.
 * That is what keeps the declaration per-request rather than connection-wide;
 * `registerCapabilities()` would have been the easy path and is exactly the
 * thing SEP-2663's per-request opt-in forbids.
 *
 * ## Maintenance
 *
 * REVISIT ON EVERY `@modelcontextprotocol/client` BUMP. Two things could break
 * it, and both fail loudly rather than silently dropping the declaration:
 *
 *  - the private member is renamed or removed ⇒
 *    {@link TasksExtListenMetaSeamError} on the attempted listen;
 *  - the prologue stops being synchronous (an `await` moves above the request
 *    literal) ⇒ the post-call verification below sees the override was never
 *    invoked and throws.
 *
 * Delete this module once the client package accepts caller `_meta` on
 * `listen()`.
 */

import { Client } from "@modelcontextprotocol/client";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { mergeClientCapabilities } from "./capabilities.js";
import { MCP_TASKS_EXTENSION_ID } from "./tasks-dispatch.js";
import type { ClientCapabilityOptions } from "./types.js";

/** The private upstream member being shadowed. Named once. */
const ENVELOPE_MEMBER = "_outboundMetaEnvelope" as const;

/** Client package version this shadow was verified against. */
const VERIFIED_CLIENT_VERSION = "2.0.0";

/** Thrown when the seam this shadow depends on is no longer where it was. */
export class TasksExtListenMetaSeamError extends Error {
  constructor(reason: string) {
    super(
      `Cannot declare io.modelcontextprotocol/tasks on subscriptions/listen: ${reason}. ` +
        `\`Protocol.${ENVELOPE_MEMBER}\` is a private member of @modelcontextprotocol/client ` +
        `(verified against ${VERIFIED_CLIENT_VERSION}); without it the listen request would go ` +
        `out undeclared and a conforming server would answer -32021. Re-verify ` +
        `sdk/src/mcp-client-manager/tasks-ext-listen-meta.ts against the new client build, or ` +
        `disable task notifications and fall back to polling.`
    );
    this.name = "TasksExtListenMetaSeamError";
  }
}

type EnvelopeFn = () => Record<string, unknown> | undefined;

/**
 * Runs `call` with the tasks extension merged into the client's outbound
 * capabilities envelope, for the synchronous prologue of that one call only.
 *
 * `call` MUST read the envelope synchronously (see the module comment); a call
 * that does not is a seam change and throws rather than silently sending an
 * undeclared request.
 *
 * `disposeUnobserved` is how that throw stays leak-free. The seam check can
 * only run once `call` has SETTLED — for `listen()` that is after the server's
 * acknowledgement, so by the time we decide the declaration never reached the
 * wire the subscription is already live on the server. The caller receives a
 * rejection and therefore never gets the handle, so nothing else can ever tear
 * it down; without this hook every attempt would leak one server-side
 * subscription. Give it whatever closes `T`.
 */
export function withTasksExtensionEnvelope<T>(
  client: Client,
  declaredCapabilities: ClientCapabilityOptions | undefined,
  call: () => Promise<T>,
  disposeUnobserved?: (value: T) => void | Promise<void>
): Promise<T> {
  const target = client as unknown as Record<string, unknown>;
  const original = target[ENVELOPE_MEMBER];
  if (original === undefined) {
    throw new TasksExtListenMetaSeamError("the member is absent");
  }
  if (typeof original !== "function") {
    throw new TasksExtListenMetaSeamError(
      `the member is a ${typeof original}, not a function`
    );
  }
  const inherited = original as EnvelopeFn;
  const merged = mergeClientCapabilities(declaredCapabilities, {
    extensions: { [MCP_TASKS_EXTENSION_ID]: {} },
  } as ClientCapabilityOptions);

  let observed = false;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, ENVELOPE_MEMBER);
  const ownDescriptor = hadOwn
    ? Object.getOwnPropertyDescriptor(target, ENVELOPE_MEMBER)
    : undefined;

  Object.defineProperty(target, ENVELOPE_MEMBER, {
    value: function shadowedOutboundMetaEnvelope(
      this: unknown
    ): Record<string, unknown> | undefined {
      observed = true;
      const base = inherited.call(this) ?? {};
      // Replace only the capabilities key. The protocol-version and client-info
      // keys upstream generated stay exactly as they were.
      return { ...base, [CLIENT_CAPABILITIES_META_KEY]: merged };
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });

  const restore = () => {
    if (ownDescriptor) {
      Object.defineProperty(target, ENVELOPE_MEMBER, ownDescriptor);
    } else {
      delete target[ENVELOPE_MEMBER];
    }
  };

  let pending: Promise<T>;
  try {
    pending = call();
  } catch (error) {
    restore();
    throw error;
  }
  // The synchronous prologue has run by now; anything later must not see the
  // widened envelope.
  restore();

  // The seam check rides ON the pending promise rather than short-circuiting
  // it. Two reasons: a call that also rejected must surface ITS error (the
  // server's `-32021` is more useful than our diagnosis of it), and abandoning
  // `pending` here would leave an unhandled rejection behind.
  return pending.then(async (value) => {
    if (!observed) {
      // Either the prologue became asynchronous or upstream stopped consulting
      // the envelope for listen. Both mean the request went out undeclared.
      //
      // Whatever `call` produced is about to be thrown away, so it has to be
      // torn down HERE: the caller only ever sees the rejection, so a live
      // subscription handle we do not close is a subscription nobody will ever
      // close. Disposal failures are swallowed — the seam error is the fact
      // worth reporting, and a failed close is at worst the leak we were
      // already trying to avoid.
      if (disposeUnobserved) {
        try {
          await disposeUnobserved(value);
        } catch {
          // Swallowed, including a synchronous throw.
        }
      }
      throw new TasksExtListenMetaSeamError(
        "the request was built without reading the outbound capabilities envelope, " +
          "so the eligibility declaration did not reach the wire"
      );
    }
    return value;
  });
}

/** Depth cap on the `inner` delegation walk; also the cycle guard. */
const MAX_DELEGATION_DEPTH = 16;

function isUpstreamClient(value: object): value is Client {
  return (
    value instanceof Client ||
    typeof (value as Record<string, unknown>)[ENVELOPE_MEMBER] === "function"
  );
}

/**
 * The upstream `Client` behind a `ManagedMcpClient`-shaped object, found by
 * walking the public `inner` delegation chain. `undefined` means nothing in the
 * chain is an upstream client — a test double, which has no envelope to widen.
 */
export function resolveListenMetaTarget(managed: object): Client | undefined {
  let current: unknown = managed;
  for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if (isUpstreamClient(current)) return current;
    current = (current as { inner?: unknown }).inner;
  }
  return undefined;
}
