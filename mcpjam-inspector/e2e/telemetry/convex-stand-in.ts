/**
 * Just enough of Convex's sync protocol for the hosted app to mount, over
 * Playwright's `page.routeWebSocket` — no deployment, no network.
 *
 * Why it exists: in hosted mode even a signed-out visitor is a Convex-
 * authenticated guest, and `App` (which owns `useSessionPrivacy`) does not
 * mount until `users:ensureUser` has run for that identity. Without a backend
 * the page stops at "Loading", no privacy level is ever resolved, and nothing
 * records — so a telemetry test against it would pass by observing nothing.
 *
 * What it answers, all from the client's own messages (`convex/browser`
 * `sync/protocol.js` is the reference):
 *
 *  - `Authenticate` → a `Transition` that bumps the identity version, which is
 *    how the server confirms a token.
 *  - `ModifyQuerySet` → a `Transition` to the client's new query-set version,
 *    with every added query resolved to `null`: the app renders its empty
 *    states, which is all the telemetry proof needs.
 *  - `Mutation` → a successful `MutationResponse`, then a `Transition` past
 *    its timestamp so the client treats it as complete. `Action` → success.
 *
 * The replies are deliberately dumb. Nothing here is under test; it only has
 * to be convincing enough that the code that IS under test runs.
 */
import type { Page, WebSocketRoute } from "@playwright/test";

/** Convex encodes its u64 timestamps as little-endian base64. */
function encodeTs(value: bigint): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes.toString("base64");
}

interface Version {
  querySet: number;
  identity: number;
  ts: bigint;
}

function wire(version: Version) {
  return { ...version, ts: encodeTs(version.ts) };
}

/** Ids in Convex's shape (lowercase base32-ish, digits included). */
const GUEST_USER_ID = "k17telemetrye2eguestuser0001";
const PROJECT_ID = "k17telemetrye2eproject000001";
const ORGANIZATION_ID = "k17telemetrye2eorganization1";

/**
 * The data a signed-out guest's shell needs to get past its gates: a user row
 * (`currentUser === null` is the "Could not finish setup" screen) and, once
 * `projects:ensureDefaultProject` has run, one project. Every other query
 * resolves to `null` — "none" — which the app renders as an empty state.
 */
interface StandInState {
  projects: Array<Record<string, unknown>>;
}

function queryResult(udfPath: string, state: StandInState): unknown {
  switch (udfPath) {
    case "users:getCurrentUser":
      return {
        _id: GUEST_USER_ID,
        _creationTime: 1_700_000_000_000,
        isGuest: true,
        name: "Guest",
      };
    case "projects:getMyProjects":
      return state.projects;
    case "organizations:getMyOrganizations":
    case "servers:getProjectServers":
      return [];
    case "servers:listForProjects":
      // Keyed by project id.
      return Object.fromEntries(
        state.projects.map((project) => [project._id, []]),
      );
    default:
      return null;
  }
}

function serve(ws: WebSocketRoute, log?: (line: string) => void) {
  const version: Version = { querySet: 0, identity: 0, ts: 0n };
  const state: StandInState = { projects: [] };
  /** Live subscriptions, so a mutation can push what it changed. */
  const subscriptions = new Map<number, string>();

  const transition = (
    next: Partial<Omit<Version, "ts">>,
    modifications: unknown[] = [],
  ) => {
    const start = { ...version };
    version.querySet = next.querySet ?? version.querySet;
    version.identity = next.identity ?? version.identity;
    version.ts += 1n;
    ws.send(
      JSON.stringify({
        type: "Transition",
        startVersion: wire(start),
        endVersion: wire(version),
        modifications,
        clientClockSkew: 0,
      }),
    );
  };

  const updated = (queryId: number, udfPath: string) => ({
    type: "QueryUpdated",
    queryId,
    value: queryResult(udfPath, state),
    logLines: [],
    journal: null,
  });

  ws.onMessage((raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (message.type) {
      case "Connect":
        // A fresh connection starts from version zero on both sides.
        version.querySet = 0;
        version.identity = 0;
        version.ts = 0n;
        subscriptions.clear();
        break;
      case "Authenticate":
        transition({ identity: Number(message.baseVersion ?? 0) + 1 });
        break;
      case "ModifyQuerySet": {
        const modifications = Array.isArray(message.modifications)
          ? (message.modifications as Array<Record<string, unknown>>)
          : [];
        const results: unknown[] = [];
        for (const modification of modifications) {
          const queryId = Number(modification.queryId);
          if (modification.type === "Add") {
            const udfPath = String(modification.udfPath);
            log?.(`query ${udfPath}`);
            subscriptions.set(queryId, udfPath);
            results.push(updated(queryId, udfPath));
          } else if (modification.type === "Remove") {
            subscriptions.delete(queryId);
            results.push({ type: "QueryRemoved", queryId });
          }
        }
        transition(
          { querySet: Number(message.newVersion ?? version.querySet) },
          results,
        );
        break;
      }
      case "Mutation": {
        const udfPath = String(message.udfPath);
        log?.(`mutation ${udfPath}`);
        let result: unknown = null;
        if (udfPath === "projects:ensureDefaultProject") {
          if (state.projects.length === 0) {
            state.projects.push({
              _id: PROJECT_ID,
              _creationTime: 1_700_000_000_000,
              name: "Default",
              servers: {},
              organizationId: ORGANIZATION_ID,
              ownerId: GUEST_USER_ID,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
            });
          }
          result = PROJECT_ID;
        }
        // The response's timestamp is the one the next transition ends at:
        // the client completes a mutation once its query set reaches it, and
        // that transition carries whatever the mutation changed.
        ws.send(
          JSON.stringify({
            type: "MutationResponse",
            requestId: message.requestId,
            success: true,
            result,
            ts: encodeTs(version.ts + 1n),
            logLines: [],
          }),
        );
        transition(
          {},
          [...subscriptions].map(([queryId, path]) => updated(queryId, path)),
        );
        break;
      }
      case "Action":
        log?.(`action ${String(message.udfPath)}`);
        ws.send(
          JSON.stringify({
            type: "ActionResponse",
            requestId: message.requestId,
            success: true,
            result: null,
            logLines: [],
          }),
        );
        break;
      default:
        break;
    }
  });
}

/**
 * Serve every Convex sync socket the page opens. `log` receives one line per
 * query, mutation and action — the first thing to read when the app stops
 * at an error screen because some query needs a real answer.
 */
export async function installConvexStandIn(
  page: Page,
  options: { log?: (line: string) => void } = {},
): Promise<void> {
  await page.routeWebSocket(/\/api\/[^/]+\/sync$/, (ws) =>
    serve(ws, options.log),
  );
}

/**
 * A guest session the app accepts: `/api/web/guest-session`'s shape, with an
 * unsigned JWT the Convex client can decode for its refresh schedule. Only
 * the stand-in ever sees the token.
 */
export function guestSessionBody(): string {
  const now = Math.floor(Date.now() / 1000);
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = [
    segment({ alg: "none", typ: "JWT" }),
    segment({
      sub: "guest_telemetry_e2e",
      iss: "https://telemetry-e2e.invalid",
      aud: "convex",
      iat: now,
      exp: now + 3600,
    }),
    "unsigned",
  ].join(".");
  return JSON.stringify({
    guestId: "guest_telemetry_e2e",
    token,
    expiresAt: (now + 3600) * 1000,
  });
}
