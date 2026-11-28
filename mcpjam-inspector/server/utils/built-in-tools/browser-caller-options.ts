/**
 * What an unattended caller of the browser tools can ask of each command
 * without the model seeing it: the readiness reviewer sign-in stops at
 * MCPJam's OAuth callback, limits each credential to the sign-in server's
 * origin, and counts its password submissions. Kept beside `browser.ts`, which
 * only wires these in.
 */
import type {
  BrowserCommand,
  BrowserCommandSecret,
} from "../../services/browserd/protocol.js";

export interface BrowserNavigationStop {
  /** The page whose top-level navigation is stopped before it loads. */
  url: string;
  /** Told the full URL the redirect carried. The model is never told. */
  onStopped: (url: string) => void;
}

/**
 * Asked with the NAMES a command is about to deliver, before any value leaves
 * this process. A string refuses the command with that message.
 */
export type BrowserSecretGate = (
  names: readonly string[],
  command: { commandId: string },
) => Promise<string | undefined>;

/** Whether a delivered credential reached a field: `unknown` counts as typed. */
export type SecretDeliveryOutcome = "not_typed" | "typed" | "unknown";

/** Told, after the daemon answers, what became of a delivered credential. */
export type BrowserSecretReport = (
  names: readonly string[],
  command: { commandId: string; outcome: SecretDeliveryOutcome },
) => Promise<void>;

/** Refusals the daemon gives before any keystroke lands. */
const BEFORE_TYPING =
  /^(stale_ref|stale_observation|secret_origin_refused|secret_too_short|secret_unresolved|target_not_found|target_covered|out_of_viewport|unsupported_target|unknown_tab)\b/;

const BEFORE_RUNNING = new Set(["stale_observation", "busy", "at_capacity"]);

/** What a daemon's answer says about the credential it was sent with. */
export function secretDeliveryOutcome(
  response:
    | { status: string; result?: { ok: boolean; error?: string } }
    | undefined,
): SecretDeliveryOutcome {
  if (!response) return "unknown";
  // Refused before the act runs: a stale observation, or a queue that turned
  // the command away before claiming it (`daemon/command-queue.ts`). Any
  // other refusal, a person taking the browser partway through or an id that
  // already ran (`expired`), cannot prove the value never reached the field.
  if (BEFORE_RUNNING.has(response.status)) return "not_typed";
  if (response.status !== "ok") return "unknown";
  if (response.result?.ok) return "typed";
  return BEFORE_TYPING.test(response.result?.error ?? "")
    ? "not_typed"
    : "unknown";
}

/** The persistent stop every command of the turn carries. */
export function navigationStopFields(
  stop: BrowserNavigationStop | undefined,
): Pick<BrowserCommand, "stopAt" | "stopAtPersistent"> {
  return stop ? { stopAt: stop.url, stopAtPersistent: true } : {};
}

const FEATURE_REFUSALS: Record<string, string> = {
  "secret-placeholders":
    "secret_unsupported_daemon: this browser is running an older " +
    "build that cannot fill in a {{secret:...}} placeholder, so " +
    "nothing was typed. Ask the user to restart the browser " +
    "session, or have them type the credential themselves.",
  "secret-origins":
    "secret_unsupported_daemon: this browser cannot limit a credential to " +
    "the sign-in page's origin, so nothing was typed.",
  "navigation-stop-persistent":
    "browser_unavailable: this browser cannot stop at the page this run " +
    "ends on, so nothing was run.",
};

/** The daemon features a command needs for what it carries. */
export function requiredDaemonFeatures(args: {
  secrets?: ReadonlyArray<BrowserCommandSecret>;
  navigationStop?: BrowserNavigationStop;
}): string[] {
  return [
    ...(args.secrets?.length ? ["secret-placeholders"] : []),
    ...(args.secrets?.some((secret) => secret.origins !== undefined)
      ? ["secret-origins"]
      : []),
    ...(args.navigationStop ? ["navigation-stop-persistent"] : []),
  ];
}

/**
 * Checks a daemon's features once per boot: a daemon announces them when it
 * starts, so a command with a stop does not cost a status call each time.
 */
export function createFeatureCheck() {
  let known: { bootId: string; features: readonly string[] } | undefined;
  return async (
    handle: {
      bootId: string;
      client: {
        status(options?: {
          signal?: AbortSignal;
        }): Promise<{ kind: string; features?: readonly string[] }>;
      };
    },
    needed: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (needed.length === 0) return undefined;
    if (known?.bootId !== handle.bootId) {
      try {
        const status = await handle.client.status(signal ? { signal } : {});
        const features = status.kind === "ok" ? (status.features ?? []) : [];
        // Only a successful answer is remembered; a refusal is asked again.
        if (status.kind === "ok") known = { bootId: handle.bootId, features };
        const missing = needed.find((feature) => !features.includes(feature));
        return missing ? FEATURE_REFUSALS[missing] : undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    const missing = needed.find((feature) => !known!.features.includes(feature));
    return missing ? FEATURE_REFUSALS[missing] : undefined;
  };
}

/** What the model reads after its command reached the page the run ends on. */
export const STOPPED_FOR_CALLER =
  "This page is where the task ends, so the browser stopped before loading " +
  "it and MCPJam has taken over. Do not act further; reply with one line " +
  "saying what you did.";

/**
 * Hands a stopped navigation's URL to the caller. Returns the model's view of
 * it, or `undefined` when the command was not stopped.
 */
export function takeNavigationStop(
  stop: BrowserNavigationStop | undefined,
  result: { stoppedAt?: string } | undefined,
): { ok: true; output: { stopped: true; note: string } } | undefined {
  const url = stop ? result?.stoppedAt : undefined;
  if (!stop || !url) return undefined;
  stop.onStopped(url);
  return { ok: true, output: { stopped: true, note: STOPPED_FOR_CALLER } };
}

/**
 * A credential limited to an origin, typed with no named field, would land
 * wherever focus is, which can be a frame another site put on the page.
 */
export const SECRET_TARGET_REQUIRED =
  "secret_target_required: a credential limited to a sign-in origin is typed " +
  "only with `type` into a field you name by `ref`, never by selector, " +
  "coordinates or focus, and never with `fill_form`; nothing was typed. " +
  "Observe, then type into the field's ref.";
