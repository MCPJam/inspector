/**
 * The Playground's throwaway-computer path.
 *
 * Every CLOUD harness turn runs on a disposable, per-conversation box: killed
 * after 30 idle minutes, capped at 4 hours of age, and limited to 4 live boxes
 * per user and 12 per org. There is no persistent machine in this path, so a
 * Claude Code / Codex / Cursor client needs only its own harness flag.
 *
 * Why a box rather than the member's personal computer: a personal computer is
 * reused, attached to several hosts, and has no stable binding to an
 * environment, so a project's credentials never go there. The reasons a turn
 * takes a box:
 *
 *   `credential`   — the harness authenticates on the customer's own account
 *     (Cursor). Its key reaches only a box the project provisioned.
 *   `compare`      — a compare column. Every column runs the same host at the
 *     same time; each gets its own conversation's box so they cannot overwrite
 *     each other's files.
 *   `conversation` — every other cloud harness turn (a plain Claude Code or
 *     Codex turn). The conversation's box is its machine.
 *
 * A LOCAL harness (npx / Electron) runs on the member's own machine and is never
 * given a box; neither is a scenario session (its own box path) or a turn with
 * no harness. This module owns the decision and the acquisition; the chat
 * routes only ask it.
 */
import { logger } from "../logger.js";
import {
  provisionPlaygroundTerminalSandbox,
  touchSandbox,
  type ControlPlaneResult,
  type PlaygroundTerminalSandbox,
} from "../computers/control-plane-client.js";
import {
  acquireHarnessBox,
  canProvisionHarnessBoxes,
  type AcquireHarnessBoxResult,
  type HarnessBox,
} from "./harness-box.js";
import {
  ExternalAccountCredentialRefusal,
  resolveExternalAccountCredentialPlan,
} from "./external-account-credentials.js";
import { convexListProjectSecretBindings } from "../computers/convex-secrets-client.js";
import { createConvexClient } from "../../routes/v1/convex-client.js";
import {
  ExternalCredentialMissingError,
  externalCredentialSecretSelection,
  type ExternalCredentialSecret,
} from "@/shared/external-credential-selection";
import { getHarnessAdapter, harnessUsesExternalAccount } from "./registry.js";

export type PlaygroundBoxReason = "credential" | "compare" | "conversation";

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
  return "conversation";
}

export interface PlaygroundBoxRefusal {
  status: number;
  error: string;
  code?: string;
}

/**
 * The HIDDEN environment a Playground turn on a client that signs in with the
 * member's own account (Cursor) runs under, when the turn targets the client
 * itself rather than an environment — which is every such turn while the
 * environments UI is off.
 *
 * An environment is the backend's grant boundary for secrets: the box carries
 * a brokered key only if the environment named on its row selects it. So the
 * route mints (or, deduped by fingerprint, finds) an ad-hoc environment for
 * the client that selects the member's own usable key and nothing else, and
 * names it on the box. It selects no servers (`serverSelection: none`): the
 * turn keeps its client's live server selection exactly as before, and the
 * environment is never shown or targeted for anything but the grant.
 *
 * Refuses, BEFORE any box is booted, when the member has no usable key, with
 * copy that says where to add it in the UI they have. Never "use an
 * environment".
 */
export async function resolvePlaygroundCredentialEnvironment(args: {
  bearer: string;
  projectId: string;
  hostId: string;
  harnessId: string;
  /** Test seams. */
  listSecrets?: typeof convexListProjectSecretBindings;
  ensureAdhocEnvironment?: (input: {
    projectId: string;
    hostId: string;
    secretSelection: { mode: "explicit"; secretIds: string[] };
  }) => Promise<{ environmentId: string }>;
}): Promise<
  | { ok: true; environmentId: string }
  | { ok: false; status: 409 | 502; message: string }
> {
  const bearer = args.bearer.replace(/^Bearer\s+/i, "");
  let secrets: ExternalCredentialSecret[];
  try {
    secrets = (await (args.listSecrets ?? convexListProjectSecretBindings)(
      bearer,
      { projectId: args.projectId },
    )) as ExternalCredentialSecret[];
  } catch (error) {
    logger.warn("[playground-box] secret list failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      status: 502,
      message:
        "Couldn't read your project's secrets to find your key for this client. Try again in a moment.",
    };
  }
  let secretSelection: { mode: "explicit"; secretIds: string[] } | undefined;
  try {
    secretSelection = externalCredentialSecretSelection(
      { harness: args.harnessId },
      secrets,
    );
  } catch (error) {
    if (!(error instanceof ExternalCredentialMissingError)) throw error;
    return {
      ok: false,
      status: 409,
      message: `${error.message} Add or fix it under Project Settings → Secrets, then send again.`,
    };
  }
  if (!secretSelection) {
    return {
      ok: false,
      status: 409,
      message: "This client needs no key of its own.",
    };
  }
  try {
    const ensure =
      args.ensureAdhocEnvironment ??
      (async (input) => {
        const result = (await createConvexClient(bearer).mutation(
          "projectEnvironments:ensureAdhocEnvironment" as never,
          {
            projectId: input.projectId,
            hostId: input.hostId,
            serverSelection: { mode: "none" },
            secretSelection: input.secretSelection,
          } as never,
        )) as { environment: { environmentId: string } };
        return { environmentId: result.environment.environmentId };
      });
    return {
      ok: true,
      ...(await ensure({
        projectId: args.projectId,
        hostId: args.hostId,
        secretSelection,
      })),
    };
  } catch (error) {
    logger.warn("[playground-box] hidden environment failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      status: 502,
      message:
        "Couldn't attach your key to this conversation's computer. Try again in a moment.",
    };
  }
}

/**
 * The credential check a `credential` turn would fail inside `runHarnessTurn`,
 * run BEFORE the box is booted — the same function, the same inputs — so a
 * refused turn provisions nothing. The sentence on refusal, or null when the
 * credential is satisfiable (or the harness needs none).
 *
 * `boxKind: "sandbox"` because that is where the turn is about to run: only a
 * disposable box carries a brokered key.
 */
export async function playgroundCredentialRefusal(args: {
  harnessId: string;
  secretEnv: Readonly<Record<string, string>> | undefined;
  bearer?: string;
  projectId?: string;
  environmentId?: string;
}): Promise<string | null> {
  try {
    await resolveExternalAccountCredentialPlan({
      harness: getHarnessAdapter(args.harnessId),
      secretEnv: args.secretEnv,
      ...(args.bearer ? { bearer: args.bearer } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      boxKind: "sandbox",
    });
    return null;
  } catch (error) {
    if (error instanceof ExternalAccountCredentialRefusal) return error.message;
    throw error;
  }
}

/**
 * Hold this conversation's disposable shell for the turn. The heartbeat keeps
 * its idle clock running for as long as the turn does; `release()` stops it and
 * leaves the box, so the conversation's next turn reattaches to the same files.
 *
 * `release()` also sends the turn's FINAL touch (`ended`), which tells the
 * control plane no turn holds the box any more: at the member's cap, an idle
 * box is evicted to make room instead of refusing a new conversation (a compare
 * reset mints one per column). Best-effort — a lost end touch only means the
 * box becomes evictable two heartbeats later instead of now.
 */
export async function acquirePlaygroundHarnessBox(args: {
  bearer: string;
  projectId: string;
  chatSessionId: string;
  /** The project environment whose secrets the box holds, when one is chosen. */
  projectEnvironmentId?: string;
  /** The turn's harness id; the backend gates the box on its own flag. */
  harness?: string;
  signal?: AbortSignal;
}): Promise<AcquireHarnessBoxResult<PlaygroundBoxRefusal>> {
  const acquired = await acquireHarnessBox<PlaygroundBoxRefusal>({
    surface: "playground",
    // The turn's signal: a stopped or abandoned turn stops beating, and the
    // box idles out on its own clock (it is never torn down by the turn).
    ...(args.signal ? { signal: args.signal } : {}),
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
          ...(args.harness ? { harness: args.harness } : {}),
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
  if (!acquired.ok) return acquired;
  const box = acquired.box;
  let ended: Promise<void> | null = null;
  return {
    ok: true,
    box: {
      ...box,
      release: () =>
        (ended ??= (async () => {
          await box.release();
          try {
            await touchSandbox({
              sandboxRowId: box.binding.sandboxRowId,
              sandboxId: box.binding.sandboxId,
              ended: true,
              signal: AbortSignal.timeout(10_000),
            });
          } catch {
            // Best-effort; see above.
          }
        })()),
    },
  };
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
  if (reason === "credential") {
    return `The ${harness} harness signs in with your own account, so it runs on a disposable computer for this conversation`;
  }
  if (reason === "compare") {
    return `Compare columns each run the ${harness} harness on a disposable computer of their own`;
  }
  return `The ${harness} harness runs on a disposable computer for this conversation`;
}

/**
 * A sentence for a refusal the control plane sent as a bare machine code (an
 * older control plane answered `{ error: "not_owner" }`). Anything else is
 * already written for a human and is kept as is.
 */
const REFUSAL_CODE_SENTENCES: Record<string, string> = {
  not_member: "you are not a member of this project.",
  not_owner: "this conversation's computer belongs to someone else.",
  environment_unavailable:
    "the environment this conversation runs in is unavailable.",
  image_unavailable: "its computer image is unavailable.",
};

function refusalSentence(refusal: PlaygroundBoxRefusal): string {
  return REFUSAL_CODE_SENTENCES[refusal.error.trim()] ?? refusal.error;
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
      message: `${subject}, and one couldn't be started: ${refusalSentence(refusal)}`,
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
