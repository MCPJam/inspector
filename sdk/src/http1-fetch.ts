/**
 * HTTP/1.1 for MCP traffic on runtimes whose built-in `fetch` negotiates
 * HTTP/2 (CQT-216).
 *
 * Node 26 bundles undici 8, whose `fetch` negotiates HTTP/2 with any TLS
 * server that offers it; Node 24 and earlier speak HTTP/1.1. On that HTTP/2
 * path, a request aborted in the same tick it starts keeps its stream open
 * with no `'error'` listener. When undici reaps the idle session about four
 * seconds later, that stream's `socket idle timeout` error is uncaught and the
 * process exits (nodejs/undici#6143). An MCP client that connects and at once
 * disconnects does exactly that to its standalone GET stream, so a single
 * conformance connection check killed the local Inspector.
 *
 * `allowH2: false` is undici's documented way to keep HTTP/1.1 (its v7 to v8
 * migration guide), and the MCP TypeScript SDK maintainers recommend handing
 * the transport such a `fetch` on affected Node versions. It is applied PER
 * REQUEST, as the default `fetch` of MCP connections and conformance runs,
 * never to the process: forcing HTTP/1.1 globally breaks any unrelated
 * service that only speaks HTTP/2. A caller that supplies its own `fetch`
 * keeps it.
 *
 * The dispatcher is NODE'S OWN global one, composed, never one built from the
 * npm `undici` package: a dispatcher from a different undici major than the
 * bundled one does not speak the same handler protocol. Composing also keeps
 * any proxy or TLS dispatcher the application installed.
 *
 * Revisit once a Node 26 release bundles the undici fix.
 */

/** The global dispatcher's slot, shared by undici 7.30+ and undici 8. */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.2");

type RuntimeVersions = Readonly<Record<string, string | undefined>>;

type Dispatch = (options: Record<string, unknown>, handler: unknown) => boolean;

interface ComposableDispatcher {
  dispatch: Dispatch;
  compose: (
    interceptor: (dispatch: Dispatch) => Dispatch
  ) => ComposableDispatcher;
}

const http1DispatcherFor = new WeakMap<
  ComposableDispatcher,
  ComposableDispatcher
>();

/**
 * Whether this runtime's built-in `fetch` negotiates HTTP/2 by default: Node
 * with undici 8 or later. Bun and browsers never take this path.
 */
export function fetchNegotiatesHttp2(
  versions: RuntimeVersions | undefined = globalThis.process?.versions
): boolean {
  if (!versions || versions.bun !== undefined) return false;
  return Number.parseInt(versions.undici ?? "", 10) >= 8;
}

function isComposableDispatcher(value: unknown): value is ComposableDispatcher {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispatch" in value &&
    typeof value.dispatch === "function" &&
    "compose" in value &&
    typeof value.compose === "function"
  );
}

/**
 * The dispatcher Node's `fetch` uses right now. Node creates it when undici
 * first loads, which is lazy; reading the `Headers` global loads undici
 * without sending a request.
 */
function nodeGlobalDispatcher(): ComposableDispatcher | undefined {
  if (Reflect.get(globalThis, GLOBAL_DISPATCHER) === undefined) {
    Reflect.get(globalThis, "Headers");
  }
  const current = Reflect.get(globalThis, GLOBAL_DISPATCHER);
  return isComposableDispatcher(current) ? current : undefined;
}

/** `base` with every request marked `allowH2: false`, built once per base. */
function http1Only(base: ComposableDispatcher): ComposableDispatcher {
  let http1 = http1DispatcherFor.get(base);
  if (!http1) {
    http1 = base.compose(
      (dispatch) => (options, handler) =>
        dispatch({ ...options, allowH2: false }, handler)
    );
    http1DispatcherFor.set(base, http1);
  }
  return http1;
}

/**
 * A `fetch` that keeps HTTP/1.1 where the built-in one would negotiate
 * HTTP/2, and is the built-in `fetch` everywhere else. A caller's own
 * `dispatcher` wins. The global `fetch` and dispatcher are read per request,
 * so instrumentation or a proxy installed after startup still applies.
 */
export const http1Fetch: typeof fetch = (input, init) => {
  const fetchFn = globalThis.fetch;
  if (
    !fetchNegotiatesHttp2() ||
    (init !== undefined && Reflect.get(init, "dispatcher") !== undefined)
  ) {
    return fetchFn(input, init);
  }
  const base = nodeGlobalDispatcher();
  if (!base) return fetchFn(input, init);
  const http1Init = { ...init, dispatcher: http1Only(base) };
  return fetchFn(input, http1Init);
};
