/**
 * The pure half of the browserd client: HTTP status + parsed body → a typed
 * outcome, with no `fetch`, no `Response`, and no transport of any kind.
 *
 * It exists because the daemon now has TWO callers that must agree byte for
 * byte about what a reply means. The hosted engine talks to a daemon across a
 * socket; the local and Electron engines build the same stack in-process and
 * call its request handler directly (`in-process-client.ts`). If each decoded
 * its own replies, "a person is holding the browser" could be a refusal on one
 * engine and a silent success on another — and the divergence would surface as
 * a privacy bug on whichever engine got it wrong.
 *
 * So: one decoder, two transports. Everything a caller can observe about a
 * daemon reply is decided here.
 */
import { parseBrowserdErrorCode } from "./protocol";
import type { BrowserCommandResult } from "./protocol";

/** The daemon's reply, reconstructed from the HTTP status + body. Distinct from
 *  the queue's `BrowserCommandOutcome`: it also carries the two boundary-only
 *  rejections (`stale_observation`, `unknown_boot`) the handler maps to 409. */
export type BrowserdCommandResponse =
  | { status: "ok"; result: BrowserCommandResult; bootId: string }
  | { status: "busy"; bootId: string }
  | { status: "expired"; bootId: string }
  | { status: "at_capacity"; bootId: string }
  | { status: "stale_observation"; result?: BrowserCommandResult; bootId: string }
  | { status: "unknown_boot"; bootId: string }
  /** A person is holding (or has parked) the browser — see `daemon/lease.ts`.
   *  Not an error: the correct response is to wait and tell the user, which is
   *  why it is a normal outcome variant rather than a thrown client error. */
  | {
      status: "lease_blocked";
      lease: "held" | "parked" | "required" | "other_holder";
      holder?: string;
      holderKind?: BrowserdLeaseHolderKind;
      bootId: string;
    };

export interface BrowserdHealth {
  ok: boolean;
  detail?: string;
}

/** The authenticated `/v1/status` verdict — liveness, boot identity, and the
 *  bearer's validity in one probe. `unauthorized` means the bearer this client
 *  holds is not the running daemon's secret (a relaunch signal for the durable
 *  session path, same as a bootId mismatch). */
export type BrowserdStatus =
  | { kind: "ok"; bootId: string }
  | { kind: "unhealthy"; bootId?: string; detail?: string }
  | { kind: "unauthorized" };

/** What is holding the browser: a person at the pane, or a script over CDP. */
export type BrowserdLeaseHolderKind = "human" | "script";

/** The daemon's handoff-lease state, as this client reports it. */
export type BrowserdLeaseState =
  | { state: "free"; bootId: string }
  | {
      state: "held";
      holder: string;
      holderKind: BrowserdLeaseHolderKind;
      expiresAt?: number;
      bootId: string;
    }
  | {
      state: "parked";
      holder: string;
      holderKind: BrowserdLeaseHolderKind;
      bootId: string;
    };

/** browserd answered with a status the client cannot interpret (e.g. 401/400).
 *  These are bugs in the boot wiring, not normal protocol signals, so they throw
 *  rather than becoming a response variant. */
export class BrowserdClientError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "BrowserdClientError";
  }
}

/** A daemon reply as the decoders see it: a status code and an object body. */
export interface DecodableReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Normalize any parsed JSON to a record.
 *
 * A daemon that answers `null`, a scalar, or an array is not speaking this
 * protocol — but neither is that a reason to throw a TypeError from a field
 * read three lines later (the session reuse path reads `bootId` straight off
 * this). Every non-record body becomes "no fields".
 */
export function asRecord(parsed: unknown): Record<string, unknown> {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function bootIdOf(body: Record<string, unknown>): string {
  return typeof body.bootId === "string" ? body.bootId : "";
}

function holderKindOf(value: unknown): BrowserdLeaseHolderKind {
  return value === "script" ? "script" : "human";
}

/**
 * Which of the four 423s this is.
 *
 * `held` is the fallback rather than a fifth state: an unrecognised refusal
 * still means a person has the browser, and "wait" is the right answer to all
 * of them. Only the pane's prose depends on telling them apart.
 */
function leaseKindOf(
  code: string | undefined,
): "held" | "parked" | "required" | "other_holder" {
  switch (code) {
    case "lease_parked":
      return "parked";
    case "lease_required":
      return "required";
    case "lease_held_by_other":
      return "other_holder";
    default:
      return "held";
  }
}

export function decodeHealth(reply: DecodableReply): BrowserdHealth {
  return {
    ok: reply.status === 200 && reply.body?.ok === true,
    detail:
      typeof reply.body?.detail === "string" ? reply.body.detail : undefined,
  };
}

export function decodeStatus(reply: DecodableReply): BrowserdStatus {
  const body = reply.body;
  const bootId = typeof body.bootId === "string" ? body.bootId : undefined;
  switch (reply.status) {
    case 200:
      return bootId
        ? { kind: "ok", bootId }
        : { kind: "unhealthy", detail: "status_missing_boot_id" };
    case 503:
      return {
        kind: "unhealthy",
        bootId,
        detail: typeof body.detail === "string" ? body.detail : undefined,
      };
    case 401:
      return { kind: "unauthorized" };
    default:
      throw new BrowserdClientError(
        `browserd status probe failed (HTTP ${reply.status})`,
        reply.status,
      );
  }
}

/** Parse a `{ lease, bootId }` body, failing closed to `free` only on a 2xx. */
export function decodeLease(reply: DecodableReply): BrowserdLeaseState {
  if (reply.status !== 200 && reply.status !== 409) {
    throw new BrowserdClientError(
      `browserd lease read failed (HTTP ${reply.status})`,
      reply.status,
    );
  }
  const body = reply.body;
  const bootId = bootIdOf(body);
  const raw = body.lease;
  if (!raw || typeof raw !== "object") return { state: "free", bootId };
  const lease = raw as {
    state?: unknown;
    holder?: unknown;
    holderKind?: unknown;
    expiresAt?: unknown;
  };
  const holder = typeof lease.holder === "string" ? lease.holder : undefined;
  if (lease.state === "held" && holder) {
    return {
      state: "held",
      holder,
      holderKind: holderKindOf(lease.holderKind),
      expiresAt:
        typeof lease.expiresAt === "number" ? lease.expiresAt : undefined,
      bootId,
    };
  }
  if (lease.state === "parked" && holder) {
    return {
      state: "parked",
      holder,
      holderKind: holderKindOf(lease.holderKind),
      bootId,
    };
  }
  return { state: "free", bootId };
}

/**
 * Decode a lease ACTION. `acquire` can legitimately fail (someone else holds
 * it), and that is `{ took: false }` rather than a throw: a UI that treated a
 * refusal as an error would be as wrong as one that treated it as success.
 */
export function decodeLeaseAction(reply: DecodableReply): {
  took: boolean;
  lease: BrowserdLeaseState;
} {
  const lease = decodeLease(reply);
  if (reply.status === 200) return { took: true, lease };
  if (reply.status === 409) return { took: false, lease };
  throw new BrowserdClientError(
    `browserd rejected the lease action (HTTP ${reply.status}${
      typeof reply.body.error === "string" ? `, ${reply.body.error}` : ""
    })`,
    reply.status,
  );
}

export function decodeCommandResponse(
  reply: DecodableReply,
): BrowserdCommandResponse {
  const body = reply.body;
  const bootId = bootIdOf(body);

  switch (reply.status) {
    case 200:
      return {
        status: "ok",
        result: body.result as BrowserCommandResult,
        bootId,
      };
    case 429:
      return { status: "busy", bootId };
    case 503:
      return { status: "at_capacity", bootId };
    case 423:
      // The privacy gate: a person has the browser. Nothing ran and — the
      // point of enforcing it at the daemon — nothing was observed. Four
      // shapes reach here: a held or parked lease refusing an agent command,
      // and the two refusals of a MANUAL command that does not belong to the
      // live lease. They are one outcome to a model (wait) and four different
      // bugs to a pane (take the lease first / you are not the holder), so the
      // distinction is kept rather than flattened at the boundary.
      // Read as a CODE, not compared as a whole string: the same refusals
      // arrive bare from the request gate and as `"<code>: <detail>"` from the
      // dequeue guard (`formatBrowserdError`), and an equality test silently
      // classifies every detailed one as a plain held lease.
      return {
        status: "lease_blocked",
        lease: leaseKindOf(
          parseBrowserdErrorCode(
            typeof body.error === "string" ? body.error : undefined,
          ) ?? (typeof body.error === "string" ? body.error : undefined),
        ),
        holder: typeof body.holder === "string" ? body.holder : undefined,
        holderKind:
          body.holderKind === undefined
            ? undefined
            : holderKindOf(body.holderKind),
        bootId,
      };
    case 409:
      if (body.error === "stale_observation") {
        return {
          status: "stale_observation",
          result: body.result as BrowserCommandResult | undefined,
          bootId,
        };
      }
      if (body.error === "command_unknown_boot") {
        return { status: "unknown_boot", bootId };
      }
      return { status: "expired", bootId };
    default:
      // 401 (bad bearer), 400 (bad envelope), or anything else: a wiring bug,
      // not a protocol signal.
      throw new BrowserdClientError(
        `browserd rejected the command (HTTP ${reply.status}${
          typeof body.error === "string" ? `, ${body.error}` : ""
        })`,
        reply.status,
      );
  }
}
