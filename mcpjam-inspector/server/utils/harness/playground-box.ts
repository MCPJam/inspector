/**
 * The Playground's disposable-computer fallback.
 *
 * A Playground harness turn runs on the member's own computer. That machine is
 * the one place a conversation's files persist across sessions, and it is also
 * the one place a project's credentials never go: a personal computer is
 * reused, attached to several hosts, and has no stable binding to an
 * environment. So two kinds of turn cannot run there and take a disposable,
 * per-conversation box instead:
 *
 *   `credential` — the harness authenticates on the customer's own account
 *     (Cursor). Its key reaches only a box the project provisioned.
 *   `compare`    — a compare column. Every column runs the same host at the
 *     same time; sharing one personal computer would have them overwrite each
 *     other's files, so each column gets its own conversation's box.
 *
 * Everything else — a plain Claude Code or Codex turn — is untouched, and so is
 * a LOCAL harness, which runs on the member's own machine and is never given a
 * box. This module owns the decision and the acquisition; the two chat routes
 * only ask it.
 */
import { logger } from "../logger.js";
import {
  provisionPlaygroundTerminalSandbox,
  type ControlPlaneResult,
  type PlaygroundTerminalSandbox,
} from "../computers/control-plane-client.js";
import {
  acquireHarnessBox,
  canProvisionHarnessBoxes,
  type AcquireHarnessBoxResult,
  type HarnessBox,
} from "./harness-box.js";
import { harnessUsesExternalAccount } from "./registry.js";

export type PlaygroundBoxReason = "credential" | "compare";

/** Why this turn needs a machine of its own — or null when it does not. */
export function playgroundHarnessBoxReason(args: {
  harnessId: string | undefined;
  /** The harness runs on the member's own machine (a local target). */
  localExecution: boolean;
  /** A scenario conversation has its own box path (`surface: "scenario"`). */
  isScenarioSession: boolean;
  /** The request came from a compare column. */
  comparePane: boolean;
}): PlaygroundBoxReason | null {
  if (!args.harnessId || args.localExecution || args.isScenarioSession) {
    return null;
  }
  if (harnessUsesExternalAccount(args.harnessId)) return "credential";
  if (args.comparePane) return "compare";
  return null;
}

export interface PlaygroundBoxRefusal {
  status: number;
  error: string;
  code?: string;
}

/**
 * Hold this conversation's disposable shell for the turn. The heartbeat keeps
 * its idle clock running for as long as the turn does; `release()` stops it and
 * leaves the box, so the conversation's next turn reattaches to the same files.
 */
export async function acquirePlaygroundHarnessBox(args: {
  bearer: string;
  projectId: string;
  chatSessionId: string;
  /** The project environment whose secrets the box holds, when one is chosen. */
  projectEnvironmentId?: string;
  signal?: AbortSignal;
}): Promise<AcquireHarnessBoxResult<PlaygroundBoxRefusal>> {
  return acquireHarnessBox<PlaygroundBoxRefusal>({
    surface: "playground",
    provision: async () => {
      let result: ControlPlaneResult<PlaygroundTerminalSandbox>;
      try {
        result = await provisionPlaygroundTerminalSandbox({
          bearer: args.bearer,
          projectId: args.projectId,
          chatSessionId: args.chatSessionId,
          ...(args.projectEnvironmentId
            ? { projectEnvironmentId: args.projectEnvironmentId }
            : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        });
      } catch (error) {
        logger.warn("[playground-box] provision threw", {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false as const,
          refusal: {
            status: 502,
            error: "the computers service is unreachable",
          },
        };
      }
      if (!result.ok) {
        return {
          ok: false as const,
          refusal: {
            status: result.status,
            error: result.error,
            ...(result.code ? { code: result.code } : {}),
          },
        };
      }
      return {
        ok: true as const,
        box: {
          sandboxRowId: result.value.sandboxRowId,
          sandboxId: result.value.sandboxId,
          ...(result.value.workdir ? { workdir: result.value.workdir } : {}),
        },
      };
    },
  });
}

/** Can this server hold the box at all? Null when it can. */
export function playgroundHarnessBoxUnavailableReason(
  harness: string,
  reason: PlaygroundBoxReason,
): string | null {
  if (canProvisionHarnessBoxes()) return null;
  return `${subjectFor(harness, reason)}, which this server can't run. Open the Playground in the MCPJam web app.`;
}

function subjectFor(harness: string, reason: PlaygroundBoxReason): string {
  return reason === "credential"
    ? `The ${harness} harness signs in with your own account, so it runs on a disposable computer for this conversation`
    : `Compare columns each run the ${harness} harness on a disposable computer of their own`;
}

/**
 * The status and sentence for a refused provision. Named per cause, because
 * each has a different fix and none of them is "run it on your personal
 * computer" — which is exactly the thing this fallback exists to avoid.
 */
export function describePlaygroundBoxRefusal(
  harness: string,
  reason: PlaygroundBoxReason,
  refusal: PlaygroundBoxRefusal | undefined,
): { status: 403 | 409 | 429 | 502 | 503; message: string; code?: string } {
  const subject = subjectFor(harness, reason);
  const code = refusal?.code ? { code: refusal.code } : {};
  if (refusal?.status === 429) {
    return {
      status: 429,
      message:
        refusal.error ||
        "You already have the maximum number of live Playground computers. Finish another conversation first.",
      ...code,
    };
  }
  if (refusal?.status === 403 || refusal?.status === 409) {
    return {
      status: refusal.status,
      message: `${subject}, and one couldn't be started: ${refusal.error}`,
      ...code,
    };
  }
  const atCapacity = refusal?.status === 503;
  return {
    status: atCapacity ? 503 : 502,
    message:
      `${subject}, and one couldn't be started` +
      (refusal?.error ? `: ${refusal.error}` : ".") +
      (atCapacity ? " Retry in a moment." : ""),
    ...code,
  };
}

/**
 * Hold a box for exactly as long as a streamed response is being read.
 *
 * The route that returns a stream has no hook of its own for "the turn is
 * over", and a heartbeat that outlives its turn keeps the conversation's box
 * from idling out. Closing, erroring and cancelling the body all end the hold;
 * `release()` is idempotent, so a double signal costs nothing. A response with
 * no body (a refusal) ends it at once.
 */
export function releaseBoxWhenStreamEnds(
  response: Response,
  box: Pick<HarnessBox, "release"> | undefined,
): Response {
  if (!box) return response;
  if (!response.body) {
    void box.release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await box.release();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await box.release();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await box.release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
