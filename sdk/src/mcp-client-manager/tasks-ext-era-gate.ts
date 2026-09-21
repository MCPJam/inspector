/**
 * Per-instance shadow of the upstream client's OUTBOUND era gate, scoped to
 * the three `io.modelcontextprotocol/tasks` (SEP-2663) extension methods.
 *
 * ## What upstream does
 *
 * `@modelcontextprotocol/client@2.0.0-beta.4` derives a "spec method universe"
 * from the UNION of its two era registries
 * (`isSpecRequestMethod`, `src-*.mjs:3964`: `ALL_CODECS.some(c =>
 * c.hasRequestMethod(m))`, with `ALL_CODECS = [rev2025Codec, rev2026Codec]`).
 * `Protocol._assertOutboundRequestInEra` (`src-*.mjs:5932`) then throws
 * `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` for any member of that union that
 * the NEGOTIATED era's codec does not define. It is called from all three send
 * paths: `request()` (`:5886`), `_requestWithSchema()` (`:5951`) and
 * `ctx.mcpReq.send` (`:5791`) — "an explicit schema never smuggles a deleted
 * method onto the wire".
 *
 * ## Why that is wrong for this extension
 *
 * `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` are members of
 * the union solely via the **2025-11-25** registry (`src-*.mjs:2048-2051`),
 * which is where the *in-core* tasks utility lived. The 2026-07-28 registry
 * (`:3685-3695`) has none of them, because that utility was DELETED from core
 * and reborn as this extension — which reuses two of the same method names.
 * So on a 2026-07-28 connection the client refuses to send the EXTENSION's
 * `tasks/get` / `tasks/cancel`, reading them as deleted core methods. They are
 * collateral damage of a name collision, not of a real deletion. (`tasks/update`
 * is in neither registry, so it is era-blind and needs nothing from here — it
 * is listed anyway so the exemption set is exactly the extension's method set
 * rather than a hand-picked subset that would rot the moment a registry moves.)
 *
 * The era gate is a v2-only construct; the extension was authored against SDK
 * v1, where no such gate exists. There is no public seam to fix this properly:
 * the registries are module-private, the codec surface is function-only, and
 * `Protocol` is not exported — so this installs an own-property shadow on the
 * one instance we constructed.
 *
 * ## Why it is provably inert on the legacy revisions
 *
 * The early return requires `codec.era === "2026-07-28"`. `codecForVersion`
 * (`src-*.mjs:3942`) maps every legacy revision — 2025-03-26, 2025-06-18,
 * 2025-11-25, and `undefined` — to `rev2025Codec`, whose `era` is
 * `"2025-11-25"` (`:2214`). On any of those connections the shadow delegates
 * unconditionally, so `tasks/get`/`tasks/cancel` keep taking the legacy
 * in-core path (`tasks.ts`) with byte-identical behavior.
 *
 * `codec.era` is compared rather than our own negotiated-version constant on
 * purpose: upstream resolves ANY modern revision (including a pinned draft
 * that is not the literal `2026-07-28`) to `rev2026Codec`, and the era string
 * is what the gate itself reads. Comparing a protocol-version constant would
 * miss those and silently re-block the extension.
 *
 * ## What is deliberately NOT done
 *
 * Pinning the tasks methods to the 2025 codec instead. `rev2025Codec
 * .outboundEnvelope` returns `undefined` (`:2240`) whereas `rev2026Codec
 * .outboundEnvelope` (`:3800`) attaches the
 * `io.modelcontextprotocol/clientCapabilities` `_meta` envelope that the
 * extension's per-request eligibility declaration rides in — a codec swap
 * would silently strip the declaration and earn a `-32021` from every
 * conforming server.
 *
 * ## When it is installed, and why not at connect
 *
 * LAZILY, on the first `io.modelcontextprotocol/tasks` operation — never at
 * client construction or connect. The factory only *registers* the upstream
 * instance behind its `ManagedMcpClient`
 * ({@link registerTasksExtensionEraGateTarget}); the shadow itself is put on
 * by {@link ensureTasksExtensionEraGateShadow}, which `tasks-ext.ts` calls
 * from the single send path shared by `tasks/get`, `tasks/update` and
 * `tasks/cancel`.
 *
 * Registration is a fast path, never a precondition: a `ManagedMcpClient` that
 * did NOT come from the factory (a directly-constructed
 * `OfficialSdkClientAdapter`, say) is resolved by walking its public
 * `ManagedMcpClient.inner` delegation chain, so it gets the same shadow. The
 * only case that installs nothing is a chain with no upstream client in it at
 * all — a test double, which has no era gate to shadow. See
 * {@link resolveTasksExtensionEraGateTarget}.
 *
 * The reason is blast radius. This module probes a PRIVATE upstream member,
 * and a bump that renames it must fail loudly (see Maintenance) — but that
 * failure has to land on the feature that depends on the probe, not on the
 * transport. Installing at connect would put a private-member probe on the
 * critical path of EVERY connection: a renamed member would break 2025-03-26,
 * 2025-06-18, 2025-11-25 and 2026-07-28 servers alike, including the vast
 * majority that never speak this extension. So we do NOT gate connections on
 * it. A connection is never denied because of a seam we only need for tasks;
 * the seam error can only ever surface on a tasks request.
 *
 * ## Maintenance
 *
 * REVISIT ON EVERY `@modelcontextprotocol/client` BUMP. If the private member
 * is renamed or removed, {@link installTasksExtensionEraGateShadow} throws on
 * the first extension tasks operation rather than silently no-opping, so a
 * bump that re-blocks the extension fails loudly instead of shipping a dead
 * debugger surface. Delete this module once the client package stops
 * era-gating the extension's method names (or exposes a real seam).
 */

// Runtime import: `resolveTasksExtensionEraGateTarget` needs the CLASS to tell
// a real upstream client apart from a hand-rolled stand-in when walking an
// unregistered delegation chain (see {@link isUpstreamClient}).
import { Client } from "@modelcontextprotocol/client";
// Runtime import, and `tasks-ext.ts` imports this module back for the lazy
// install. Everything derived from `TasksExtRequestMethods` is therefore read
// at CALL time, never at module-evaluation time, so neither module can observe
// the other in its temporal dead zone whichever one the bundler loads first.
import { TasksExtRequestMethods } from "./tasks-ext.js";

/**
 * The private upstream member being shadowed. Named once so the fail-loud
 * error and the override cannot disagree.
 */
const ERA_GATE_MEMBER = "_assertOutboundRequestInEra" as const;

/** Client package version this shadow was verified against. */
const VERIFIED_CLIENT_VERSION = "2.0.0";

/**
 * `rev2026Codec.era` (`src-*.mjs:3790`) — the ONLY era on which the exemption
 * applies. Read off the dist, not guessed from a protocol-version constant.
 */
const MODERN_WIRE_ERA = "2026-07-28";

/**
 * Instances already shadowed. Tracked here rather than by sniffing for an own
 * property on the client: an upstream that moved the gate from the prototype
 * to an own instance field must still be WRAPPED (and must still fail loud if
 * it is not a function), which an own-property check would silently skip.
 */
const shadowed = new WeakSet<object>();

/** Thrown when the upstream member this shadow overrides is no longer there. */
export class TasksExtEraGateSeamError extends Error {
  constructor(reason: string) {
    super(
      `Cannot install the io.modelcontextprotocol/tasks era-gate shadow: ${reason}. ` +
        `\`Protocol.${ERA_GATE_MEMBER}\` is a private member of @modelcontextprotocol/client ` +
        `(verified against ${VERIFIED_CLIENT_VERSION}); a rename or removal means the tasks ` +
        `extension's ${TasksExtRequestMethods.join(", ")} would be silently blocked on a ` +
        `${MODERN_WIRE_ERA} connection. Re-verify sdk/src/mcp-client-manager/tasks-ext-era-gate.ts ` +
        `against the new client build.`
    );
    this.name = "TasksExtEraGateSeamError";
  }
}

type EraGate = (codec: { era?: unknown }, method: unknown) => void;

/**
 * Installs the shadow on ONE client instance. Idempotent: a second call on the
 * same instance is a no-op.
 *
 * @throws {TasksExtEraGateSeamError} when the inherited member is missing or
 * is not a function — see the module comment's maintenance note.
 */
export function installTasksExtensionEraGateShadow(client: Client): void {
  const target = client as unknown as Record<string, unknown>;
  if (shadowed.has(target)) {
    return;
  }
  // Built here rather than at module scope: this module and `tasks-ext.ts`
  // import each other (see the note on the import), so the method list is only
  // safe to read once someone actually calls in.
  const exemptMethods: ReadonlySet<string> = new Set(TasksExtRequestMethods);
  const original = target[ERA_GATE_MEMBER];
  if (original === undefined) {
    throw new TasksExtEraGateSeamError("the member is absent");
  }
  if (typeof original !== "function") {
    throw new TasksExtEraGateSeamError(
      `the member is a ${typeof original}, not a function`
    );
  }
  const inherited = original as EraGate;
  Object.defineProperty(target, ERA_GATE_MEMBER, {
    value: function shadowedAssertOutboundRequestInEra(
      this: unknown,
      codec: { era?: unknown },
      method: unknown
    ): void {
      // BOTH conditions, never one: a non-tasks method on the modern era, and
      // every method on a legacy era, still go through upstream's gate.
      if (
        codec?.era === MODERN_WIRE_ERA &&
        typeof method === "string" &&
        exemptMethods.has(method)
      ) {
        return;
      }
      inherited.call(this, codec, method);
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  shadowed.add(target);
}

/**
 * `ManagedMcpClient` (or any decorator around one) → the upstream `Client`
 * instance whose gate would have to be shadowed for it.
 *
 * A FAST PATH, not the only path. The factory — the one place an upstream
 * `Client` becomes a `ManagedMcpClient` — records the pairing here, which also
 * makes the pairing authoritative: a registered value is asserted to BE the
 * upstream client, so a registered instance whose seam has moved throws rather
 * than being quietly reclassified as "not a real client". A `ManagedMcpClient`
 * built without the factory is not in here at all, and is resolved structurally
 * instead — see {@link resolveTasksExtensionEraGateTarget}.
 */
const eraGateTargets = new WeakMap<object, Client>();

/**
 * Depth cap on the `inner` delegation walk. Also the cycle guard: a decorator
 * chain that (wrongly) loops back on itself terminates here instead of hanging
 * a tasks call. Real chains are 2 links (`LogLevelMetaClient` →
 * `OfficialSdkClientAdapter` → `Client`).
 */
const MAX_DELEGATION_DEPTH = 16;

/**
 * Is this the upstream client whose gate we shadow?
 *
 * `instanceof` is the primary test. The duck-typed fallback covers a
 * dual-install of `@modelcontextprotocol/client` (two copies in the tree ⇒
 * `instanceof` is false against a genuine client): an object that carries the
 * era-gate member as a function is one, whoever's copy built it. The fallback
 * can only ADD installs, never turn a missing seam into a silent skip — it
 * requires the member to be present and callable.
 */
function isUpstreamClient(value: object): value is Client {
  return (
    value instanceof Client ||
    typeof (value as Record<string, unknown>)[ERA_GATE_MEMBER] === "function"
  );
}

/**
 * The upstream `Client` behind `managed`, or `undefined` when there is none.
 *
 * Registered pairing first; otherwise walk the public `inner` delegation chain
 * that every adapter/decorator in this package exposes
 * (`ManagedMcpClient.inner`). The walk is what keeps a directly-constructed
 * `new OfficialSdkClientAdapter(client)` — one that never went through
 * `managed-mcp-client-factory.ts` — from silently keeping upstream's era gate
 * and dying with an opaque `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` on its
 * first `tasks/get`.
 *
 * `undefined` means exactly one thing: nothing in the chain is an upstream
 * client, i.e. a test double with no era gate to shadow. That is the ONLY
 * remaining no-op, and it is a true no-op rather than a missed install.
 */
function resolveTasksExtensionEraGateTarget(
  managed: object
): Client | undefined {
  const registered = eraGateTargets.get(managed);
  if (registered !== undefined) {
    return registered;
  }
  let current: unknown = managed;
  for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (isUpstreamClient(current)) {
      return current;
    }
    current = (current as { inner?: unknown }).inner;
  }
  return undefined;
}

/**
 * Record that `managed` speaks for `client`, so a later tasks operation can
 * find the instance to shadow. Registration alone installs NOTHING and cannot
 * throw — see the module comment on why connections are not gated on the
 * private-member probe.
 */
export function registerTasksExtensionEraGateTarget(
  managed: object,
  client: Client
): void {
  eraGateTargets.set(managed, client);
}

/**
 * Install the shadow for `managed`, if it has not been installed already.
 * Called from the single send path every extension tasks request goes through.
 *
 * The target is resolved by {@link resolveTasksExtensionEraGateTarget}:
 * registration first, then the public `inner` delegation chain. Coming from
 * the factory is therefore an optimization, not a requirement — a
 * hand-constructed `OfficialSdkClientAdapter` over a real `Client` gets the
 * same shadow the factory's would.
 *
 * A `managed` with no upstream client anywhere in its chain (a test double) is
 * a no-op: there is no era gate to shadow, so there is nothing to do and
 * nothing to fail about. One that DOES resolve to an upstream client whose
 * seam has moved throws — that is the loud failure the probe exists for, now
 * scoped to tasks traffic.
 *
 * @throws {TasksExtEraGateSeamError} when the resolved instance no longer
 * carries the private member.
 */
export function ensureTasksExtensionEraGateShadow(managed: object): void {
  const client = resolveTasksExtensionEraGateTarget(managed);
  if (client === undefined) {
    return;
  }
  installTasksExtensionEraGateShadow(client);
}
