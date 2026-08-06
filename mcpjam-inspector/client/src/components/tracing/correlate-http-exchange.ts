/**
 * Pair a JSON-RPC frame in the Logs list with the HTTP exchange it rode in.
 *
 * The two are separate log entries on purpose — the transport hands over
 * headers when the fetch resolves, which is after the `send` frame was logged
 * and before the `receive` frames are parsed, so there is no moment at which a
 * frame and its headers are both in hand (see `HttpExchangeBusEvent`). That
 * makes correlation a RENDER-TIME concern, and this module is the whole of it.
 *
 * The bar is deliberately high: showing the wrong request's headers under a
 * frame is worse than showing none, because the reader would then chase a
 * mirrored-header verdict that belongs to a different call. So:
 *
 * - Only OUTGOING frames get headers. A response frame has no method to match
 *   on, and one HTTP round trip can carry several of them.
 * - The method must agree, and when both sides name a target (`params.name`,
 *   `params.uri`, or a routed `params.taskId`) the names must agree too.
 * - Repeats pair by ORDINAL: the nth `tools/call execute-sql` frame takes the
 *   nth matching exchange. Two identical calls in flight at once cannot be
 *   told apart by content, and ordinal pairing is at least stable and is what
 *   a reader comparing the two lists by eye would do.
 * - An exchange is never paired to a frame logged AFTER it. The fetch resolves
 *   second, so `exchange.timestamp >= frame.timestamp` always holds for a real
 *   pair.
 *
 * When nothing satisfies all of that, the frame renders exactly as it does
 * today. Absence is the honest answer.
 */

/**
 * `TASK_ROUTED_METHODS` is the SDK's own set — the SEP-2663 methods whose
 * `Mcp-Name` comes from `params.taskId` rather than `params.name`/`params.uri`.
 * Imported rather than restated: the CAPTURE side
 * (`deriveMirroredBodyValues`) reads `taskId` for exactly these, so a local
 * copy would be a literal list `tsc` cannot check against the original, and
 * the tasks extension is versioned independently of core.
 */
import {
  TASK_ROUTED_METHODS,
  type HttpExchangeLogEvent,
} from "@mcpjam/sdk/browser";

/** The minimum a log row must expose to take part in correlation. */
export type CorrelatableLogItem = {
  id: string;
  serverId: string;
  direction: string;
  timestamp: string;
  payload: unknown;
  source: string;
};

type FrameIdentity = {
  method: string;
  /** `params.name` / `params.uri` / routed `params.taskId`, when present. */
  name?: string;
};

/**
 * The method and routing target a frame's body carries — the same two values
 * the transport mirrors into `Mcp-Method` / `Mcp-Name`, read off the frame
 * rather than off the headers so the comparison stays a cross-check.
 */
export function frameIdentity(payload: unknown): FrameIdentity | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const { method, params } = payload as {
    method?: unknown;
    params?: {
      name?: unknown;
      uri?: unknown;
      taskId?: unknown;
    };
  };
  if (typeof method !== "string" || method.length === 0) {
    return undefined;
  }

  const routedTaskId = TASK_ROUTED_METHODS.has(method)
    ? params?.taskId
    : undefined;
  const name = params?.name ?? params?.uri ?? routedTaskId;
  return {
    method,
    ...(typeof name === "string" ? { name } : {}),
  };
}

function isOutgoing(item: CorrelatableLogItem): boolean {
  return item.direction.toUpperCase() === "SEND";
}

function exchangeOf(
  item: CorrelatableLogItem
): HttpExchangeLogEvent | undefined {
  return item.source === "http"
    ? (item.payload as HttpExchangeLogEvent)
    : undefined;
}

/**
 * True when an exchange's captured body values are consistent with a frame's.
 *
 * `bodyValues` is absent when the request body was not a single JSON-RPC
 * request (a batch, or a non-JSON body), and in that case there is nothing to
 * agree on — treated as NO match rather than a free pass, since a batch's
 * headers describe no single frame.
 */
function agrees(
  exchange: HttpExchangeLogEvent,
  identity: FrameIdentity
): boolean {
  const values = exchange.bodyValues;
  if (!values || values.method !== identity.method) {
    return false;
  }
  // A name on only one side is not a disagreement: `deriveMirroredBodyValues`
  // omits it for methods that carry no routing target.
  if (
    identity.name !== undefined &&
    values.name !== undefined &&
    values.name !== identity.name
  ) {
    return false;
  }
  return true;
}

/**
 * The exchange belonging to `frame`, or `undefined` when nothing matches
 * confidently. `items` is the full log list in any order.
 */
export function findExchangeForFrame(
  frame: CorrelatableLogItem,
  items: CorrelatableLogItem[]
): HttpExchangeLogEvent | undefined {
  // Allow-list the one source that carries MCP JSON-RPC frames rather than
  // excluding `"http"`. OAuth (`direction: "OAUTH"`) and Apps
  // (`"UI→HOST"`/`"HOST→UI"`) rows are already excluded by `isOutgoing`, but
  // that makes correctness depend on a direction STRING in another module; an
  // allow-list keeps it a property of this one.
  if (frame.source !== "mcp-server" || !isOutgoing(frame)) {
    return undefined;
  }
  const identity = frameIdentity(frame.payload);
  if (!identity) {
    return undefined;
  }

  const frameAt = Date.parse(frame.timestamp);
  if (Number.isNaN(frameAt)) {
    return undefined;
  }

  // Ordinal position of this frame among identical ones on the same server:
  // count the matching frames logged strictly before it. Ties on an identical
  // timestamp break on `id` so the ordering is total and stable — two frames
  // must not both claim ordinal 0 and render the same exchange.
  const siblings = items
    .filter((item) => {
      if (item.serverId !== frame.serverId) return false;
      // Same allow-list as the frame itself: the sibling set decides this
      // frame's ordinal, so admitting a row the entry guard would reject
      // would shift the index and pair it with the wrong exchange.
      if (item.source !== "mcp-server" || !isOutgoing(item)) return false;
      const other = frameIdentity(item.payload);
      if (!other) return false;
      return other.method === identity.method && other.name === identity.name;
    })
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
        a.id.localeCompare(b.id)
    );
  const ordinal = siblings.findIndex((item) => item.id === frame.id);
  if (ordinal < 0) {
    return undefined;
  }

  // Ordinal is taken over ALL matching exchanges, not over a time-filtered
  // subset: filtering first would shift the index whenever an earlier call's
  // exchange fell outside the window, quietly pairing frame n with exchange
  // n+1. The window is applied to the SELECTED match instead, below.
  const candidates = items
    .filter((item) => {
      if (item.serverId !== frame.serverId) return false;
      const exchange = exchangeOf(item);
      return Boolean(exchange && agrees(exchange, identity));
    })
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
        a.id.localeCompare(b.id)
    );

  const match = candidates[ordinal];
  if (!match) {
    return undefined;
  }

  // Plausibility check on the pair, not on the search. The fetch resolves
  // after the frame was logged, so an exchange stamped meaningfully earlier is
  // not this frame's — which is how a desync shows up if the store's
  // oldest-first trim ever cut a frame away from its exchange (both share one
  // capped list, so they normally age out together). A slow call can take
  // minutes, so there is deliberately no upper bound. The 1s slack absorbs
  // skew between the two capture points; hosted stamps both server-side.
  if (Date.parse(match.timestamp) < frameAt - 1000) {
    return undefined;
  }
  return exchangeOf(match);
}

/**
 * The frame an EXCHANGE carried, or `undefined` when nothing pairs.
 *
 * The inverse of {@link findExchangeForFrame}, and implemented by running that
 * function rather than by mirroring its rules: the ordinal pairing, the
 * allow-list and the timestamp plausibility window are subtle enough that a
 * second implementation would eventually disagree with the first, and a
 * DISAGREEMENT here means a reader is shown one call's arguments next to
 * another call's headers — the exact failure the forward direction is careful
 * to avoid.
 *
 * Used by the standalone HTTP row, which needs the frame's `params.arguments`
 * to judge the `Mcp-Param-*` headers it is displaying.
 */
export function findFrameForExchange(
  exchangeItem: CorrelatableLogItem,
  items: CorrelatableLogItem[]
): CorrelatableLogItem | undefined {
  const exchange = exchangeOf(exchangeItem);
  if (!exchange) return undefined;
  const method = exchange.bodyValues?.method;
  if (method === undefined) return undefined;
  const name = exchange.bodyValues?.name;

  // Ordinal-matched, then confirmed ONCE. Testing every candidate with
  // `findExchangeForFrame` would re-scan the whole log per candidate — O(n²)
  // per expanded row on a list capped at 1000 — and the forward function
  // already pairs by ordinal, so the nth matching frame is the only one that
  // can pair with the nth matching exchange. The single confirmation keeps
  // the forward rules authoritative (timestamp plausibility included), which
  // is the property this direction exists to preserve.
  //
  // The ordinal must therefore be counted over the SAME cohort the forward
  // direction counts over: method AND routing target, not method alone. Two
  // `tools/call`s to different tools are one cohort under a method-only
  // ordinal but two cohorts forward, so the second call's exchange would look
  // up frame #1 (the OTHER tool), fail confirmation, and render no headers at
  // all. `agrees` is reused for the exchange side so the two cohorts are
  // defined by one predicate, including its rule that a name present on only
  // one side is not a disagreement.
  const sameServer = items.filter(
    (item) => item.serverId === exchangeItem.serverId
  );
  const byTime = (a: CorrelatableLogItem, b: CorrelatableLogItem) =>
    Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    a.id.localeCompare(b.id);
  const identity: FrameIdentity = {
    method,
    ...(typeof name === "string" ? { name } : {}),
  };

  const exchanges = sameServer
    .filter((item) => {
      const other = exchangeOf(item);
      return Boolean(other && agrees(other, identity));
    })
    .sort(byTime);
  const ordinal = exchanges.findIndex((item) => item.id === exchangeItem.id);
  if (ordinal < 0) return undefined;

  const frames = sameServer
    .filter((item) => {
      if (item.source !== "mcp-server" || !isOutgoing(item)) return false;
      const other = frameIdentity(item.payload);
      // Frame-side cohort, matching the forward `siblings` filter exactly:
      // there the names are compared with `===`, so an undefined name on one
      // side and a string on the other is a DIFFERENT cohort. Reusing that
      // strictness keeps the two ordinals countable against each other.
      return (
        other?.method === method &&
        other.name === (typeof name === "string" ? name : undefined)
      );
    })
    .sort(byTime);

  const candidate = frames[ordinal];
  if (!candidate) return undefined;
  return findExchangeForFrame(candidate, items) === exchange
    ? candidate
    : undefined;
}
