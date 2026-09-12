/**
 * The NATIVE adapter: MCPJam's `ui_*` tools, published to whatever WebMCP
 * agent the browser is running.
 *
 * The other adapter is `ui-tool-executor.ts` (Ask MCPJam). Both execute
 * through `ui-tool-execution.ts`, so an external agent and the in-app one
 * drive the same inspector actions with the same arguments and get the same
 * results. What is different is everything around the call: an external agent
 * discovers these tools without anyone opening the MCPJam sidebar, its own
 * browser owns its approval flow, and a native call NEVER creates a
 * conversation or opens a panel.
 *
 * ## What it does
 *
 * Subscribes to the UI tools registry and keeps the browser's registrations in
 * step with it — global tools stay up across navigation, a surface's tools
 * appear when its screen mounts and go when it leaves. Only definitions that
 * say `nativePublication: { kind: "publish" }` are mirrored; the tools that
 * need an MCPJam conversation (`ui_ask_user`, the eval-authoring group) are
 * internal and stay internal.
 *
 * ## The three races this is built around
 *
 * 1. **Duplicate names.** Chromium rejects `registerTool` for a name it
 *    already holds, so a replacement CANNOT overlap its predecessor. Work for
 *    one name is therefore serialized on a per-name chain: retire, wait for
 *    the platform to acknowledge, then register.
 *
 * 2. **Registration results that arrive late.** `registerTool` is async, and
 *    StrictMode, HMR and a fast navigation can all replace a registration
 *    while its promise is still pending. `live` is the ownership map and each
 *    entry carries its own AbortController: the moment an entry stops being
 *    the owner it is marked dead and — unless it has a call to protect —
 *    aborted on the spot, so a pending registration never lands after its
 *    publisher is gone. Because the abort belongs to that one registration,
 *    a late teardown can only ever remove its own, never the replacement.
 *
 * 3. **Unregistering during a call.** Chrome only guarantees that
 *    unregistering leaves in-flight executions alone from 153 onward, and the
 *    pinned Chromium is 151. So a registration with an accepted call is left
 *    standing until that call settles, while being marked dead so any further
 *    call through it is refused rather than executed.
 *
 * ## What it never does
 *
 * Retry a failed call (a UI tool can add a server or spend quota — a silent
 * second attempt is a second action), expose tools to other origins
 * (`exposedTo` is never set), or report a tool's arguments or results: the
 * diagnostics below carry names, counts, statuses and durations only.
 */

import { track } from "@/lib/analytics";
import {
  nativeDescriptorFor,
  resolveNativeModelContext,
  type NativeModelContextHome,
  type NativeToolDescriptor,
} from "./native-model-context";
import {
  executeUiToolCall,
  uiToolErrorResult,
  uiToolUnavailableResult,
} from "./ui-tool-execution";
import {
  shouldPublishNatively,
  useUiToolsRegistry,
  type UiToolDefinition,
} from "./ui-tools-registry";

/**
 * How long a teardown waits for an accepted call before aborting the
 * registration anyway.
 *
 * The deferral exists so a call in progress is not cut off mid-flight; it is
 * not a promise to wait forever. A handler that never settles would otherwise
 * pin a dead tool to the page for the rest of the session — including
 * blocking the replacement registration that a remount is waiting to make.
 * Well past the inspector command bus's own timeouts, so a real call reaches
 * its own failure long before this fires.
 */
const TEARDOWN_GRACE_MS = 30_000;

interface NativeRegistration {
  name: string;
  /** The exact definition object this registration was built from. */
  def: UiToolDefinition;
  /** Aborting this unregisters the tool. Never aborted while a call runs. */
  controller: AbortController;
  /** Resolves when the platform has accepted or refused. Never rejects. */
  settled: Promise<void>;
  /** No longer the live owner: refuse calls that still arrive through it. */
  disposed: boolean;
  inFlight: number;
  /** Resolvers waiting for `inFlight` to reach zero. */
  idleWaiters: Array<() => void>;
}

export interface NativeUiToolPublisher {
  /**
   * Retire every registration and stop following the registry. In-flight
   * calls are still allowed to finish (see TEARDOWN_GRACE_MS).
   */
  stop(): void;
  /** Where the API was found — for diagnostics and tests. */
  readonly home: NativeModelContextHome | null;
  /**
   * Settles once the work queued so far has been applied. Tests await this;
   * nothing in the app does.
   */
  whenSettled(): Promise<void>;
}

type DiagnosticEvent =
  | "ui_tool_native_published"
  | "ui_tool_native_registration_failed"
  | "ui_tool_native_call_completed";

function report(event: DiagnosticEvent, props: Record<string, unknown>): void {
  try {
    track(event, { location: "webmcp", ...props });
  } catch {
    // Diagnostics must never break a tool call or a registration.
  }
}

/** An error's NAME only — messages can quote a page or a server. */
function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0 && name.length <= 64) {
      return name;
    }
  }
  return "unknown";
}

let invocationCounter = 0;
function mintInvocationId(name: string): string {
  invocationCounter += 1;
  return `native-${name}-${invocationCounter}`;
}

function publishableTools(): Map<string, UiToolDefinition> {
  const out = new Map<string, UiToolDefinition>();
  for (const def of useUiToolsRegistry.getState().tools.values()) {
    if (shouldPublishNatively(def)) out.set(def.name, def);
  }
  return out;
}

/**
 * Start mirroring the registry onto the browser's WebMCP surface.
 *
 * Returns a publisher even when the browser has no WebMCP API: it publishes
 * nothing, reports nothing, and `stop()` is a no-op — MCPJam's own agent is
 * unaffected, which is the whole point of the capability check.
 */
export function startNativeUiToolPublisher(): NativeUiToolPublisher {
  const resolved = resolveNativeModelContext();
  if (!resolved) {
    return {
      stop: () => {},
      home: null,
      whenSettled: () => Promise.resolve(),
    };
  }
  const { api, home } = resolved;

  const live = new Map<string, NativeRegistration>();
  /** Per-name serialization: see race 1 in the module comment. */
  const chains = new Map<string, Promise<void>>();
  let stopped = false;
  let announced = false;

  /** Queue work for ONE name behind whatever is already queued for it. */
  function onName(name: string, task: () => Promise<void>): Promise<void> {
    const previous = chains.get(name) ?? Promise.resolve();
    // `.then(task, task)` rather than `.then(task)`: a rejected predecessor
    // must not strand every later change to this name.
    const next = previous.then(task, task).catch(() => {});
    chains.set(name, next);
    return next;
  }

  function releaseInFlight(entry: NativeRegistration): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.inFlight > 0) return;
    const waiters = entry.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function whenIdle(entry: NativeRegistration): Promise<void> {
    if (entry.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, TEARDOWN_GRACE_MS);
      entry.idleWaiters.push(settle);
    });
  }

  /**
   * The DECISION that a registration is over, taken synchronously at the
   * moment it is made rather than whenever the name's chain gets to it.
   *
   * Two things have to happen immediately. The entry is dead, so a call the
   * browser still routes through it is refused instead of executed. And when
   * nothing has been accepted yet, the registration is aborted right here —
   * including while `registerTool` is still pending, which is what stops a
   * torn-down publisher's late registration from colliding with the one that
   * replaced it (StrictMode's second mount, a hot reload).
   *
   * The one case that does NOT abort now is the one the deferral exists for:
   * a call this registration already accepted is still running.
   */
  function markRetired(entry: NativeRegistration): void {
    entry.disposed = true;
    if (entry.inFlight === 0) entry.controller.abort();
  }

  /** The WAIT, on the name's chain: let the platform finish with it. */
  async function awaitRetired(entry: NativeRegistration): Promise<void> {
    if (entry.inFlight > 0) {
      await whenIdle(entry);
      entry.controller.abort();
    }
    // Wait for the platform to finish with this registration before the name
    // can be claimed again — an overlapping claim is the duplicate-name
    // rejection this whole chain exists to avoid.
    await entry.settled;
  }

  function buildExecute(
    entry: NativeRegistration,
  ): NativeToolDescriptor["execute"] {
    return async (args, ctx) => {
      if (entry.disposed || stopped) {
        // The underlying tool is gone (its screen unmounted, the page is
        // tearing down) but the platform still holds this registration while
        // an earlier call finishes. Refuse — never act on a dead tool.
        return uiToolUnavailableResult(entry.name);
      }
      entry.inFlight += 1;
      const startedAt = Date.now();
      try {
        const outcome = await executeUiToolCall({
          toolName: entry.name,
          input: args,
          caller: "native_webmcp",
          invocationId: mintInvocationId(entry.name),
          // The agent's own cancellation, when the browser supplies one (not
          // at the pinned Chromium — see `native-model-context.ts`). Shared
          // execution checks it before dispatch and hands it to the handler;
          // an abort never un-does an action that already happened.
          ...(ctx?.signal ? { signal: ctx.signal } : {}),
        });
        report("ui_tool_native_call_completed", {
          tool_name: entry.name,
          status: outcome.status,
          duration_ms: Date.now() - startedAt,
          ...(outcome.errorCode ? { error_code: outcome.errorCode } : {}),
        });
        return outcome.result;
      } catch (error) {
        // `executeUiToolCall` is written not to throw; if it ever does, the
        // agent still gets a readable result instead of an opaque rejection.
        report("ui_tool_native_call_completed", {
          tool_name: entry.name,
          status: "threw",
          duration_ms: Date.now() - startedAt,
          error_code: errorCodeOf(error),
        });
        return uiToolErrorResult(
          `UI tool "${entry.name}" failed before it could report a result.`,
        );
      } finally {
        releaseInFlight(entry);
      }
    };
  }

  async function registerOne(
    name: string,
    def: UiToolDefinition,
  ): Promise<void> {
    const controller = new AbortController();
    const entry: NativeRegistration = {
      name,
      def,
      controller,
      settled: Promise.resolve(),
      disposed: false,
      inFlight: 0,
      idleWaiters: [],
    };
    live.set(name, entry);
    // Assigned before the first await inside, so `awaitRetired` can never
    // observe the placeholder and conclude the platform is already done.
    entry.settled = (async () => {
      try {
        await api.registerTool(nativeDescriptorFor(def, buildExecute(entry)), {
          signal: controller.signal,
        });
        // Nothing to reconcile after the await, deliberately. If this entry
        // stopped being the owner while its registration was pending,
        // `markRetired` already aborted this controller — the platform then
        // either never registered it or dropped it, and because the abort
        // belongs to THIS registration it cannot touch the one that replaced
        // it. That is the whole ownership story; a second check here would be
        // a branch no sequence of events can reach.
      } catch (error) {
        // Individually awaited and individually caught: one refused tool must
        // not take the rest of the catalog with it.
        entry.disposed = true;
        if (live.get(name) === entry) live.delete(name);
        report("ui_tool_native_registration_failed", {
          tool_name: name,
          error_code: errorCodeOf(error),
        });
      }
    })();
    await entry.settled;
  }

  /** Bring ONE name to its desired state. Runs on that name's chain. */
  function applyName(name: string): Promise<void> {
    return onName(name, async () => {
      const current = live.get(name);
      const desired = stopped ? undefined : publishableTools().get(name);
      // Same definition object: the registry has not changed this tool, so
      // the browser's copy is already right.
      if (current && current.def === desired) return;
      if (current) {
        live.delete(name);
        markRetired(current);
        await awaitRetired(current);
      }
      // Re-read: the registry can have moved on while we waited for an
      // in-flight call, and the desired state is whatever it says NOW.
      const target = stopped ? undefined : publishableTools().get(name);
      if (!target) return;
      await registerOne(name, target);
    });
  }

  function reconcile(): void {
    const desired = publishableTools();
    const names = new Set<string>([...desired.keys(), ...live.keys()]);
    for (const name of names) void applyName(name);
    scheduleAnnouncement();
  }

  /**
   * One adoption signal per page, once something is actually published: how
   * many tools this browser accepted and which home the API was found at.
   * Re-armed on every reconcile until a pass ends with tools live, so a page
   * whose catalog mounts after the publisher does still reports.
   */
  function scheduleAnnouncement(): void {
    if (announced || stopped) return;
    void whenSettled().then(() => {
      if (announced || stopped || live.size === 0) return;
      announced = true;
      report("ui_tool_native_published", {
        api_home: home,
        tool_count: live.size,
      });
    });
  }

  const unsubscribe = useUiToolsRegistry.subscribe(() => {
    if (stopped) return;
    reconcile();
  });

  reconcile();

  /**
   * Drain the per-name chains until a full pass queues nothing new. Bounded
   * so a pathological loop cannot hang a caller; `chains` itself is bounded
   * by the number of distinct tool names this page ever registers.
   */
  async function whenSettled(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      const pending = [...chains.values()];
      await Promise.all(pending);
      const after = [...chains.values()];
      if (
        after.length === pending.length &&
        after.every((promise, index) => promise === pending[index])
      ) {
        return;
      }
    }
  }

  return {
    home,
    whenSettled,
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      for (const [name, entry] of [...live]) {
        live.delete(name);
        // Marked dead NOW — the queued wait below may sit behind a pending
        // registration, and neither a late call nor a late registration may
        // outlive this publisher.
        markRetired(entry);
        void onName(name, () => awaitRetired(entry));
      }
    },
  };
}
