/**
 * The browser's reads and writes for climbs, through the same `/api/v1`
 * operations an agent, the CLI and MCP use. The screen gets no write the
 * operations lack.
 *
 * `PlatformApiClient` already speaks every climb route with typed parameters,
 * so this wraps it rather than hand-rolling a second `fetch`. The transport
 * strips the client's own `Authorization` header so `authFetch` stays the one
 * owner of the bearer (the same shim `eval-description-experiment-api.ts`
 * uses).
 *
 * A refusal keeps its kind apart: the flag being off, a climb that is not
 * there, a request the backend refused (its message already says what failed
 * and what to do next) and a request that did not complete are four different
 * facts with four different next steps.
 */
import {
  PlatformApiClient,
  isPlatformApiError,
  type PlatformClimbLaunch,
  type PlatformClimbListItem,
  type PlatformClimbStopped,
  type PlatformClimbMeasure,
  type PlatformClimbVerdict,
  type PlatformMockChange,
} from "@mcpjam/sdk/platform";
import type {
  Climb,
  ClimbPicker,
  ClimbRoundDetail,
} from "@/components/climbs/climb-types";
import { authFetch } from "@/lib/session-token";

export type ClimbsApiErrorKind =
  | "unavailable"
  | "notFound"
  | "refused"
  | "requestFailed";

export class ClimbsApiError extends Error {
  readonly kind: ClimbsApiErrorKind;
  readonly status?: number;
  /** The backend's stable refusal code, such as `CLIMB_ROUND_IN_FLIGHT`. */
  readonly code?: string;

  constructor(
    kind: ClimbsApiErrorKind,
    message: string,
    options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ClimbsApiError";
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
  }
}

export function isClimbsApiError(error: unknown): error is ClimbsApiError {
  return error instanceof ClimbsApiError;
}

const climbsFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return authFetch(input as Parameters<typeof authFetch>[0], {
    ...init,
    headers,
  });
};

type RequestOptions = { signal?: AbortSignal };

/**
 * Routes whose bodies the SDK's typed methods do not carry yet: starting with
 * MCPJam as the picker (a model beside it), and resuming a paused climb. They
 * use the client's own request path, so headers, timeouts and errors match.
 */
class ClimbsScreenClient extends PlatformApiClient {
  startPicked(
    params: StartClimbParams,
    options?: RequestOptions,
  ): Promise<StartedClimb> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/climbs`,
      { body, declareLaunch: true },
      options,
    );
  }

  resume(
    params: { projectId: string; climbId: string },
    options?: RequestOptions,
  ): Promise<{ resumed: boolean; stepDue: boolean }> {
    const climb = `${encodeURIComponent(params.projectId)}/climbs/${encodeURIComponent(params.climbId)}`;
    return this.request("POST", `/projects/${climb}/continue`, { body: {} }, options);
  }
}

function client(): ClimbsScreenClient {
  return new ClimbsScreenClient({
    baseUrl: "/api/v1",
    // Empty on purpose: `climbsFetch` strips it and `authFetch` supplies the
    // real one, so the bearer has exactly one owner.
    getAuth: () => "",
    fetch: climbsFetch,
  });
}

const UNAVAILABLE_MESSAGE =
  "Climbs are not turned on for this account yet. Ask an MCPJam admin to enable them.";
const NOT_FOUND_MESSAGE =
  "This climb does not exist, or it belongs to another project. Go back to the suite's Climb tab.";

/** Every climb call ends here, so a caller sees one error type. */
export function mapClimbsError(
  error: unknown,
  signal?: AbortSignal,
): ClimbsApiError | unknown {
  if (signal?.aborted) return error;
  if (isClimbsApiError(error)) return error;
  if (isPlatformApiError(error)) {
    const detailCode =
      typeof error.details?.code === "string" ? error.details.code : undefined;
    if (detailCode === "FEATURE_UNAVAILABLE") {
      return new ClimbsApiError("unavailable", UNAVAILABLE_MESSAGE, {
        status: error.status,
        code: detailCode,
        cause: error,
      });
    }
    if (error.status === 404) {
      return new ClimbsApiError("notFound", NOT_FOUND_MESSAGE, {
        status: error.status,
        code: detailCode,
        cause: error,
      });
    }
    // The backend writes a refusal's message for the person: it says what
    // failed and what to do next, so it is shown as it is.
    const refused = error.status === 400 || error.status === 409 || error.status === 403;
    return new ClimbsApiError(refused ? "refused" : "requestFailed", error.message, {
      status: error.status,
      code: detailCode,
      cause: error,
    });
  }
  return new ClimbsApiError(
    "requestFailed",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

async function call<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapClimbsError(error, signal);
  }
}

export type StartClimbParams = {
  projectId: string;
  suiteId: string;
  serverId: string;
  roundLimit: number;
  creditLimit: number;
  environmentIds?: string[];
  picker?: ClimbPicker;
  /** The model MCPJam picks with. Required when `picker` is `mcpjam`. */
  pickerModel?: string;
};

export type StartedClimb = Climb & { launch: PlatformClimbLaunch };

export async function listClimbs(
  params: { projectId: string; suiteId: string; limit?: number },
  signal?: AbortSignal,
): Promise<PlatformClimbListItem[]> {
  const page = await call(() => client().listClimbs(params, { signal }), signal);
  return page.items;
}

export function getClimb(
  params: { projectId: string; climbId: string },
  signal?: AbortSignal,
): Promise<Climb> {
  return call(() => client().getClimb(params, { signal }), signal);
}

/** Resumes a paused climb from the last settled round. */
export function continueClimb(
  params: { projectId: string; climbId: string },
  signal?: AbortSignal,
): Promise<{ resumed: boolean; stepDue: boolean }> {
  return call(() => client().resume(params, { signal }), signal);
}

/**
 * Stops a climb for good, cancelling a round in flight. Stopping twice is
 * safe, so a stopped climb's summary and prompt are read the same way.
 */
export function stopClimb(
  params: { projectId: string; climbId: string },
  signal?: AbortSignal,
): Promise<PlatformClimbStopped> {
  return call(() => client().stopClimb(params, { signal }), signal);
}

/** One round in full: its verdict, the reasons, and each environment's numbers. */
export function getClimbRound(
  params: { projectId: string; climbId: string; roundNumber: number },
  signal?: AbortSignal,
): Promise<ClimbRoundDetail> {
  return call(() => client().getClimbRound(params, { signal }), signal);
}

/** Overrules a settled round. The backend records who did and the reason. */
export function decideRound(
  params: {
    projectId: string;
    climbId: string;
    roundNumber: number;
    decision: Exclude<PlatformClimbVerdict, "not_decided">;
    reason: string;
  },
  signal?: AbortSignal,
): Promise<unknown> {
  return call(() => client().setClimbRoundDecision(params, { signal }), signal);
}

/** Sets what the climb is for. The backend refuses it once round 1 has settled. */
export function updateClimbMeasure(
  params: { projectId: string; climbId: string; measure: PlatformClimbMeasure },
  signal?: AbortSignal,
): Promise<Climb> {
  return call(() => client().updateClimb(params, { signal }), signal);
}

const changeCache = new Map<string, Promise<PlatformMockChange[]>>();

/**
 * What a mock version changed since an earlier one of the same mock. A saved
 * version never changes, so each answer is kept for the page's life.
 */
export function mockChangesBetween(params: {
  projectId: string;
  mockId: string;
  version: number;
  sinceVersion: number;
}): Promise<PlatformMockChange[]> {
  const key = `${params.projectId}:${params.mockId}:${params.sinceVersion}:${params.version}`;
  const known = changeCache.get(key);
  if (known) return known;
  // Readers share this promise, so it is tied to no one reader's signal.
  const read = call(async () => {
    const mock = await client().getMockServer(params);
    return mock.changes ?? [];
  });
  changeCache.set(key, read);
  // A failed read is not kept, so the next render asks again.
  read.catch(() => changeCache.delete(key));
  return read;
}

export function forgetMockChanges(): void {
  changeCache.clear();
}

/** Starts a climb and its baseline. SPENDS credits: the baseline runs every case twice in each environment. */
export function startClimb(
  params: StartClimbParams,
  signal?: AbortSignal,
): Promise<StartedClimb> {
  return call(() => client().startPicked(params, { signal }), signal);
}
