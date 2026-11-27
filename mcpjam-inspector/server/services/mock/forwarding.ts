/**
 * A mock's real server as the route hands it to the SDK runtime.
 *
 * - `authorizeForward` asks the backend for the current policy and the
 *   caller's access, on every call and immediately before the dispatch. A read
 *   that fails throws, and the runtime then refuses without dispatching.
 * - The base is contacted only after that answer allows it. The connection is
 *   opened on first use, as the caller, and closed when the request ends.
 * - While forwarding is blocked (or its policy cannot be read), `describe`
 *   and `listTools` answer from the listing pinned when the version was
 *   saved, with no network read of the base.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import { isRealUnreachable, realUnreachableError, type MockRealServer } from "@mcpjam/sdk/mocks";
import { ErrorCode } from "../../routes/web/errors.js";
import { logger } from "../../utils/logger.js";
import type { PinnedDiscovery, ResolvedMock } from "./backend.js";
import type { OpenReal } from "./connection.js";
import { forwardFanOutMessage } from "./forward-fan-out.js";
import { FORWARD_REFUSAL_MESSAGES, type ForwardVerdict } from "./forward-policy.js";
import { realServerOn, type LiveRealServer } from "./real-server.js";
import type { MockDialProfile } from "./registry.js";
import type { ManagerCallerContext } from "../../routes/web/auth.js";

export interface ForwardingInput {
  resolved: ResolvedMock & { baseServerId: string };
  caller: ManagerCallerContext;
  bearerToken: string;
  profile: MockDialProfile;
  signal: AbortSignal;
  open: OpenReal;
  /** The policy and access check, bound to this request. */
  check: (signal?: AbortSignal) => Promise<ForwardVerdict>;
  /**
   * Takes one forward from the caller's fan-out allowance, or says how long to
   * wait. Set by the in-process door; a limited forward is never dispatched.
   */
  takeForward?: () => { retryAfterSeconds: number } | null;
}

export interface ForwardingReal {
  real: MockRealServer;
  /** Closes the connection if one was opened. Never throws. */
  close(): Promise<void>;
}

/**
 * A fixed phrase for why the real server could not be opened. The error's own
 * text can carry the server's name or address, and the mock names neither.
 */
function unreachable(error: unknown): Error {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  // A stdio base asks this device before it runs, as for a direct connection;
  // a mock cannot ask, so it says where the person can.
  if (code === ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED) {
    return new Error(
      "this mock's real server runs a command this device has not approved. Connect the real server from Servers to review and approve it",
    );
  }
  return new Error(
    [status, code].some((n) => n === 401 || n === 403)
      ? "the real server did not accept your sign-in"
      : "the real server could not be opened",
  );
}

/** Closes a connection; a failure to close is logged, never raised. */
async function closeQuietly(manager: Pick<MCPClientManager, "disconnectAllServers">) {
  try {
    await manager.disconnectAllServers();
  } catch (error) {
    logger.debug("[mock-route] closing a connection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function forwardingRealServer(input: ForwardingInput): ForwardingReal {
  const { resolved, check } = input;
  const id = resolved.baseServerId;
  const pinned: PinnedDiscovery = resolved.discovery ?? {};
  let opened: Promise<{ manager: MCPClientManager; live: LiveRealServer }> | undefined;

  const connect = () =>
    (opened ??= (async () => {
      const real = await input.open(input);
      try {
        await real.manager.connectToServer(id, real.config, { signal: input.signal });
      } catch (error) {
        await closeQuietly(real.manager);
        throw error;
      }
      return { manager: real.manager, live: realServerOn(real.manager, id) };
    })());
  const live = async (): Promise<LiveRealServer> => {
    try {
      return (await connect()).live;
    } catch (error) {
      logger.warn("[mock-route] could not open the real server of a mock", {
        mockId: resolved.mockId,
        error: error instanceof Error ? error.name : typeof error,
      });
      const reason = unreachable(error);
      // An approval the person must give is not an outage: it keeps its own words.
      if ((error as { code?: unknown } | null)?.code === ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED) throw reason;
      throw realUnreachableError(reason);
    }
  };
  /**
   * Discovery while the base is down: the pinned contract serves it, so a
   * mock's own entries and self-contained answers keep working through an
   * outage. A version with nothing pinned has nothing to serve and says the
   * base is unreachable.
   */
  const duringOutage = async <T>(read: () => Promise<T>, pinnedAnswer: () => T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (!resolved.discovery || !isRealUnreachable(error)) throw error;
      logger.warn("[mock-route] the real server is unreachable; serving the pinned listing", {
        mockId: resolved.mockId,
        error: error instanceof Error ? error.name : typeof error,
      });
      return pinnedAnswer();
    }
  };
  const pinnedInfo = () => ({
    capabilities: pinned.capabilities ?? {},
    ...(pinned.serverInfo && { serverInfo: pinned.serverInfo }),
    ...(pinned.instructions !== undefined && { instructions: pinned.instructions }),
  });
  /** Discovery may touch the base only when forwarding is allowed right now. */
  const mayReadBase = async (signal?: AbortSignal) => {
    try {
      return (await check(signal)).allowed;
    } catch (error) {
      logger.warn("[mock-route] the forwarding policy could not be read; serving the pinned listing", {
        mockId: resolved.mockId,
        error: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  };

  const real: MockRealServer = {
    describe: async (options) =>
      (await mayReadBase(options?.signal))
        ? duringOutage(async () => (await live()).describe(options), pinnedInfo)
        : pinnedInfo(),
    listTools: async (options) =>
      (await mayReadBase(options?.signal))
        ? duringOutage(async () => (await live()).listTools(options), () => pinned.tools ?? [])
        : (pinned.tools ?? []),
    // Every family, from the saved contract; the backend already left out what this caller may not read.
    pinnedListing: async (family) => (pinned[family] ?? []) as never,
    authorizeForward: async (_request, options) => {
      const verdict = await check(options?.signal);
      return verdict.allowed
        ? { allowed: true }
        : { allowed: false, reason: verdict.reason, message: FORWARD_REFUSAL_MESSAGES[verdict.reason] };
    },
    callTool: async (call) => {
      const limited = input.takeForward?.();
      if (limited) {
        // A tool error, so the agent reads it and waits, rather than a failure of the mock.
        return { isError: true, content: [{ type: "text", text: forwardFanOutMessage(limited.retryAfterSeconds) }] };
      }
      return (await live()).callTool(call);
    },
    request: async (request, options) => {
      const limited = input.takeForward?.();
      if (limited) throw new Error(forwardFanOutMessage(limited.retryAfterSeconds));
      return (await live()).request(request, options);
    },
    // A stateless request has no stream to carry a list change to the client.
    onListChanged: () => () => undefined,
  };

  return {
    real,
    close: async () => {
      let connection: Awaited<NonNullable<typeof opened>> | undefined;
      try {
        connection = await opened;
      } catch {
        return; // opening failed, was logged by `live()`, and left nothing to close
      }
      if (connection) await closeQuietly(connection.manager);
    },
  };
}
