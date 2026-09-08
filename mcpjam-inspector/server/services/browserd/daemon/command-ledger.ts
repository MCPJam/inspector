/**
 * The browser command ledger — one ordered record of everything that was asked
 * of this browser, and what happened.
 *
 * WHY IT LIVES IN THE DAEMON, and specifically at the request handler's command
 * entry rather than around the executor: the executor never sees a refusal. A
 * lease refusal is answered before `queue.submit`, so is `command_unknown_boot`,
 * and the queue's own `busy` / `expired` / `at_capacity` outcomes never reach an
 * executor either. A wrapper around `CommandExecutor` would therefore record
 * exactly the commands that ran and silently lose every command that was
 * REFUSED — and "the agent tried to drive while a person held the browser" is
 * the single most useful row in the whole trace. The handler is the one place
 * that sees every disposition, so the handler writes the row.
 *
 * WHY THE DAEMON RATHER THAN THE INSPECTOR: the daemon is where the lease is
 * enforced and where every source's commands converge on one per-tab FIFO —
 * manual, chat, inspector, eval and agent alike. One ring here is one ORDER,
 * minted by one counter. Two rings, one per caller, would each be internally
 * ordered and mutually meaningless, and the question a trace exists to answer
 * ("who touched this page, in what order") has no answer in that shape.
 *
 * WHAT IT IS NOT: durable. This ring is bounded and per-boot. The inspector
 * mirrors it into a durable sink (JSONL locally) and the ring's job is to lose
 * nothing between mirrors — and to say so, with a `gap` row, when it does.
 * Missing history is always explicit; nothing here is silently best-effort.
 */
import type {
  BootId,
  BrowserAction,
  BrowserCommand,
  BrowserCommandSource,
  ObservationStateToken,
} from "../protocol";

/**
 * Who issued a command.
 *
 * `kind` is the CATEGORY and `id` tells two of a kind apart — two coding agents
 * driving one session are both `"agent"`, and a trace that could not separate
 * them would be a trace of "something happened". Stamped by the inspector route
 * that authenticated the caller and echoed here; the daemon never invents one
 * and never reads one from a place a caller could have written it.
 */
export interface BrowserLedgerActor {
  kind: "agent" | "model" | "human" | "inspector";
  /**
   * `cli:<clientId>`, `mcp:<clientName>`, `model:<modelId>`, `pane:<userId>`, or
   * `anonymous` on a self-hosted inspector with no sign-in — which is a fact the
   * trace should SHOW rather than paper over with a plausible-looking id.
   */
  id: string;
  label?: string;
}

/** What else this command belongs to, when the caller knows. */
export interface BrowserLedgerCorrelation {
  chatSessionId?: string;
  turnId?: string;
  toolCallId?: string;
  evalRunId?: string;
  iterationId?: string;
  swarmId?: string;
}

/**
 * How a command is recorded, AFTER the capture policy has run over it.
 *
 * Deliberately not the raw `BrowserAction`: a `type` verb's value is a
 * password as often as it is a search term, and a ledger that stored it would
 * make "share this session" mean "share my credentials". See `redactAction`.
 */
export type BrowserLedgerCommandRecord = {
  /**
   * `note` is not a browser action. It is the marker `note_browser_session`
   * writes — one row, nothing sent to the page — and it is in this union rather
   * than smuggled in as an `observe` so a reader never has to wonder which
   * observations were real.
   */
  kind: BrowserAction["kind"] | "note";
  verb?: string;
  mode?: string;
  target?: { selector?: string; a11yRef?: string; coordinates?: [number, number] };
  /** Present when the value was kept (`press`, `select`, `scroll`). */
  value?: string;
  /** Present when the value was redacted (`type`). Shape, never content. */
  redactedValue?: { redacted: true; chars: number };
  /** `navigate` only, already stripped of query and fragment. */
  url?: string;
  /** `webmcp_invoke` only. The tool's name; its input is never recorded. */
  toolKey?: string;
};

/** An artifact the row points at, held in the daemon's bounded artifact store. */
export interface BrowserLedgerArtifactRef {
  id: string;
  bytes: number;
  mediaType: string;
  /**
   * The payload aged out of the daemon's artifact store before anything
   * mirrored it. The row still names what was captured — "there was a
   * screenshot here and it is gone" is a different and more useful statement
   * than a row that never mentions one.
   */
  evicted?: boolean;
}

/** One command, one row. */
export interface BrowserLedgerRow {
  kind: "command";
  /** Monotonic within this boot. The inspector's durable sink re-keys it. */
  seq: number;
  commandId: string;
  /** The logical session, as the inspector named it. Absent for a boot nobody attached. */
  sessionId?: string;
  bootId: BootId;
  tabId?: string;
  source: BrowserCommandSource;
  actor: BrowserLedgerActor;
  correlation?: BrowserLedgerCorrelation;
  /** ms since epoch, at the moment the command was admitted. */
  ts: number;
  durationMs: number;
  command: BrowserLedgerCommandRecord;
  /**
   * `executed` — it ran (or de-duplicated to a run whose result we have).
   * `refused` — nothing ran and nothing was observed.
   * `unknown` — it may or may not have run; the outcome is unknowable. Never
   * conflated with either of the others, because "I don't know" is the one
   * answer a caller must not read as "it didn't happen".
   */
  outcome: "executed" | "refused" | "unknown";
  ok?: boolean;
  errorCode?: string;
  /**
   * This row is a RETRY that resolved to an earlier execution of the same
   * commandId, whose own row has since aged out of the ring.
   *
   * The ordinary dedupe writes no row at all — "one execution, one row", or a
   * caller retrying through a flaky transport would appear to have clicked the
   * button twice. This flag exists for the case where the row it should have
   * linked to is gone: silently minting a second `executed` row there would
   * double-count the click, and silently dropping it would lose the fact that
   * the agent asked again.
   */
  deduped?: boolean;
  /** Already stripped of query and fragment; `data:` URLs are omitted entirely. */
  url?: string;
  title?: string;
  stateToken?: ObservationStateToken;
  viewport?: { width: number; height: number };
  artifacts?: {
    screenshot?: BrowserLedgerArtifactRef;
    a11y?: BrowserLedgerArtifactRef;
    text?: BrowserLedgerArtifactRef;
  };
  /**
   * The console/page-error ring positions AFTER this command.
   *
   * CURSORS, not deltas. A delta would need a per-actor cursor into a ring that
   * a human handoff purges, and would copy page text into every row; two rows'
   * cursors let a reader compute the same window on demand and cost two
   * integers.
   */
  consoleSeqAfter?: number;
  errorsSeqAfter?: number;
}

/**
 * History that is missing, said out loud.
 *
 * The alternative — a ring that quietly drops its oldest rows — produces a
 * trace that is indistinguishable from a session where nothing happened, which
 * is the one thing a debugging record must never look like.
 */
export interface BrowserLedgerGap {
  kind: "gap";
  seq: number;
  bootId: BootId;
  ts: number;
  fromSeq: number;
  toSeq: number;
  reason: "ring_overflow" | "daemon_restart" | "sink_unavailable";
}

export type BrowserLedgerEntry = BrowserLedgerRow | BrowserLedgerGap;

/** What a caller hands the ledger; everything else is derived here. */
export interface LedgerRecordInput {
  command: BrowserCommand;
  actor: BrowserLedgerActor;
  sessionId?: string;
  correlation?: BrowserLedgerCorrelation;
  ts: number;
  durationMs: number;
  outcome: BrowserLedgerRow["outcome"];
  ok?: boolean;
  errorCode?: string;
  deduped?: boolean;
  /** The command's output, for the fields the row lifts out of it. */
  output?: unknown;
  stateToken?: ObservationStateToken;
  viewport?: { width: number; height: number };
  cursors?: { console?: number; errors?: number };
  /**
   * Whether this row may carry ANYTHING derived from the page.
   *
   * Governs the artifacts, the URL, the title and the state token together,
   * because they are one question and not four. False while a lease is held:
   * the daemon captures nothing then, and a ledger that recorded so much as the
   * URL of the page somebody is signing into would defeat the gate that refused
   * the command in the first place.
   *
   * Enforced HERE rather than left to each caller. The guarantee is the
   * ledger's — a caller that forgets is the whole failure mode — so the check
   * lives at the one place that writes rows.
   */
  capturePage?: boolean;
  /**
   * Record `type` values verbatim instead of their shape.
   *
   * The session-level opt-in for a run that genuinely needs them back. The DOOR
   * decides whether a session may ask for this (ephemeral profiles only); by
   * the time it reaches the ledger it is a fact about this command.
   */
  captureTypedText?: boolean;
}

export interface CommandLedgerOptions {
  bootId: BootId;
  /** Rows retained in the ring before the oldest are dropped behind a gap row. */
  maxRows?: number;
  /** Artifact payloads retained. */
  maxArtifacts?: number;
  /** Total artifact bytes retained. */
  maxArtifactBytes?: number;
  /** Injectable id minter, for deterministic tests. */
  mintId?: () => string;
}

export const DEFAULT_LEDGER_OPTIONS = {
  maxRows: 512,
  maxArtifacts: 64,
  maxArtifactBytes: 32 * 1024 * 1024,
} as const;

/** A stored artifact payload. */
interface StoredArtifact {
  id: string;
  mediaType: string;
  /** base64 for images, utf8 for text/a11y. */
  encoding: "base64" | "utf8";
  data: string;
  bytes: number;
}

let artifactCounter = 0;

function defaultMintId(): string {
  artifactCounter += 1;
  return `art_${Date.now().toString(36)}_${artifactCounter.toString(36)}`;
}

/**
 * Strip a URL to what a trace may keep.
 *
 * Query and fragment go: a session token in a magic link, a search someone
 * typed, a password reset id — all of them ride there, and none of them is
 * needed to answer "which page was this". A `data:` URL is dropped entirely
 * because it IS the page content rather than a name for it.
 */
export function sanitizeLedgerUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not a URL we can reason about. Keeping an unparseable string would mean
    // keeping whatever it actually is, unexamined.
    return undefined;
  }
  if (parsed.protocol === "data:") return undefined;
  // USERINFO FIRST. `https://alice:hunter2@host/p` carries a password in the
  // URL itself, so stripping only the query and fragment would leave the one
  // credential this policy exists to keep out of a shareable history.
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * The capture policy, applied at WRITE rather than at read.
 *
 * Redacting on the way out would mean the unredacted value had already been
 * written somewhere, which is the thing being avoided. `type` is the one verb
 * whose value is withheld by default: it is where credentials are entered, and
 * the shape (`{redacted: true, chars: N}`) keeps the row diagnostic — "they
 * typed 14 characters here" is usually the whole question — without keeping
 * the secret.
 *
 * `captureTypedText` is the per-session opt-in for a run that genuinely wants
 * the values back. It is refused on a persistent profile by the door, not here:
 * this function records what it was told to record.
 */
export function redactAction(
  action: BrowserAction,
  options: { captureTypedText?: boolean } = {},
): BrowserLedgerCommandRecord {
  switch (action.kind) {
    case "navigate":
      return {
        kind: "navigate",
        ...(sanitizeLedgerUrl(action.url)
          ? { url: sanitizeLedgerUrl(action.url) }
          : {}),
      };
    case "back":
    case "reload":
      return { kind: action.kind };
    case "act": {
      const target = action.target;
      const record: BrowserLedgerCommandRecord = {
        kind: "act",
        verb: action.verb,
        ...(target
          ? {
              target:
                "selector" in target
                  ? { selector: target.selector }
                  : "a11yRef" in target
                    ? { a11yRef: target.a11yRef }
                    : { coordinates: target.coordinates },
            }
          : {}),
      };
      if (typeof action.value === "string") {
        // `press` keys, `select` options and scroll amounts are not secrets and
        // a trace without them cannot explain what happened. `type` is.
        if (action.verb === "type" && !options.captureTypedText) {
          record.redactedValue = { redacted: true, chars: action.value.length };
        } else {
          record.value = action.value;
        }
      }
      return record;
    }
    case "observe":
      return { kind: "observe", mode: action.mode };
    case "webmcp_invoke":
      // The NAME, never the input: a page tool's arguments are as arbitrary as
      // a form's, and one of them is somebody's API key.
      return { kind: "webmcp_invoke", toolKey: action.toolKey };
    case "webmcp_cancel":
      return { kind: "webmcp_cancel" };
    default: {
      const exhaustive: never = action;
      return { kind: (exhaustive as BrowserAction).kind };
    }
  }
}

export class CommandLedger {
  private readonly bootId: BootId;
  private readonly maxRows: number;
  private readonly maxArtifacts: number;
  private readonly maxArtifactBytes: number;
  private readonly mintId: () => string;

  private nextSeq = 1;
  private readonly entries: BrowserLedgerEntry[] = [];
  private readonly artifacts = new Map<string, StoredArtifact>();
  /** Every id this boot has minted, payload or not. @see knowsArtifact */
  private readonly knownArtifacts = new Set<string>();
  private artifactBytes = 0;

  constructor(options: CommandLedgerOptions) {
    this.bootId = options.bootId;
    this.maxRows = options.maxRows ?? DEFAULT_LEDGER_OPTIONS.maxRows;
    this.maxArtifacts = options.maxArtifacts ?? DEFAULT_LEDGER_OPTIONS.maxArtifacts;
    this.maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_LEDGER_OPTIONS.maxArtifactBytes;
    this.mintId = options.mintId ?? defaultMintId;
    if (!Number.isInteger(this.maxRows) || this.maxRows < 1) {
      throw new RangeError(`maxRows must be an integer >= 1, got ${this.maxRows}`);
    }
  }

  /** The highest seq minted so far. A reader's cursor starts here to tail. */
  get headSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Record one command's disposition.
   *
   * Called for EVERY command the handler answers — executed, refused or
   * unknown alike — and returns the row it wrote so the caller can hand the
   * seq straight back to a client that wants to look it up.
   */
  record(input: LedgerRecordInput): BrowserLedgerRow {
    const { command } = input;
    // The page gate, applied ONCE and up front: with `capturePage` false there
    // is no output to read, so no field below can lift anything out of it.
    const output = input.capturePage ? asRecord(input.output) : undefined;
    const artifacts = output ? this.storeArtifacts(output) : undefined;
    const url = sanitizeLedgerUrl(output?.url);
    const row: BrowserLedgerRow = {
      kind: "command",
      seq: this.nextSeq++,
      commandId: command.commandId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      bootId: this.bootId,
      ...(command.tabId ? { tabId: command.tabId } : {}),
      source: command.source,
      actor: input.actor,
      ...(input.correlation && Object.keys(input.correlation).length
        ? { correlation: input.correlation }
        : {}),
      ts: input.ts,
      durationMs: input.durationMs,
      command: redactAction(command.action, {
        captureTypedText: input.captureTypedText === true,
      }),
      outcome: input.outcome,
      ...(input.ok === undefined ? {} : { ok: input.ok }),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.deduped ? { deduped: true } : {}),
      ...(url ? { url } : {}),
      ...(typeof output?.title === "string" ? { title: output.title } : {}),
      ...(input.capturePage && input.stateToken
        ? { stateToken: input.stateToken }
        : {}),
      ...(input.capturePage && input.viewport ? { viewport: input.viewport } : {}),
      ...(artifacts && Object.keys(artifacts).length ? { artifacts } : {}),
      ...(typeof input.cursors?.console === "number"
        ? { consoleSeqAfter: input.cursors.console }
        : {}),
      ...(typeof input.cursors?.errors === "number"
        ? { errorsSeqAfter: input.cursors.errors }
        : {}),
    };
    this.push(row);
    return row;
  }

  /**
   * Note history this ledger knows it does not have.
   *
   * The `daemon_restart` case is written by whoever notices a bootId change —
   * the ring itself cannot, being new. Without it a relaunch mid-session reads
   * as a quiet stretch rather than as a browser that went away and came back.
   */
  noteGap(reason: BrowserLedgerGap["reason"], span?: { fromSeq: number; toSeq: number }): void {
    const gap: BrowserLedgerGap = {
      kind: "gap",
      seq: this.nextSeq++,
      bootId: this.bootId,
      ts: Date.now(),
      fromSeq: span?.fromSeq ?? 0,
      toSeq: span?.toSeq ?? 0,
      reason,
    };
    this.entries.push(gap);
    this.trim();
  }

  /**
   * Read forward from a cursor.
   *
   * Incremental by default: a reader tails with the `seq` it last saw, which is
   * what both the CLI's `trace` and the rail's Activity list do on a timer. A
   * `commandId` lookup is the other shape — the one a caller uses after an
   * `unknown` outcome to find out what actually happened to it.
   */
  read(options: {
    afterSeq?: number;
    commandId?: string;
    limit?: number;
  } = {}): { entries: BrowserLedgerEntry[]; headSeq: number } {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    let matched = this.entries;
    if (options.commandId !== undefined) {
      const id = options.commandId;
      matched = matched.filter(
        (entry) => entry.kind === "command" && entry.commandId === id,
      );
    }
    if (options.afterSeq !== undefined) {
      const after = options.afterSeq;
      matched = matched.filter((entry) => entry.seq > after);
    }
    return { entries: matched.slice(0, limit), headSeq: this.headSeq };
  }

  /**
   * Has this ledger ever minted this artifact id?
   *
   * Lets a reader tell a typo from a payload that aged out — 404 against 410 —
   * which are different problems with different fixes. The id set is bounded by
   * the same eviction the payloads are: it is trimmed alongside them.
   */
  knowsArtifact(id: string): boolean {
    return this.knownArtifacts.has(id);
  }

  /** Fetch one artifact payload, or undefined once it has aged out. */
  artifact(id: string):
    | { id: string; mediaType: string; encoding: "base64" | "utf8"; data: string }
    | undefined {
    const stored = this.artifacts.get(id);
    if (!stored) return undefined;
    return {
      id: stored.id,
      mediaType: stored.mediaType,
      encoding: stored.encoding,
      data: stored.data,
    };
  }

  /**
   * Forget one artifact payload, once something durable has it.
   *
   * The inspector calls this after writing a screenshot to disk: the daemon's
   * store is a hand-off buffer, not a second copy, and holding megabytes of
   * pictures that already exist as files is how a long session runs a laptop
   * out of memory.
   */
  releaseArtifact(id: string): void {
    const stored = this.artifacts.get(id);
    if (!stored) return;
    this.artifacts.delete(id);
    this.artifactBytes -= stored.bytes;
  }

  private push(row: BrowserLedgerRow): void {
    this.entries.push(row);
    this.trim();
  }

  /**
   * Drop the oldest entries past the cap and say so IN PLACE.
   *
   * The gap row is written during the trim rather than deferred to the next
   * command, because a reader can arrive at any moment — including right after
   * an overflow and before anything else happens — and a ring whose last entry
   * is a real row would then be lying about history it had just thrown away.
   *
   * The gap is inserted AFTER the drop loop, never inside it: a gap row placed
   * mid-loop is itself over the cap, gets dropped on the next iteration, and
   * the loop trims forever. So the loop only ACCUMULATES the span — absorbing
   * any older gap it passes over — and one row is written at the end.
   *
   * It goes at the FRONT, where the dropped rows were, and coalesces with a
   * leading overflow gap already there. Coalescing is what keeps this bounded:
   * one gap describing everything dropped so far, rather than a ring that fills
   * with gap rows about gap rows. The ring therefore holds `maxRows` entries
   * plus at most that one leading gap.
   *
   * Its `seq` is the LAST dropped row's, so cursor arithmetic still works: a
   * reader tailing from beyond it already has those rows and is not told about
   * a hole it does not have, while a reader starting behind it is.
   */
  private trim(): void {
    let fromSeq: number | undefined;
    let toSeq: number | undefined;
    while (this.entries.length > this.maxRows) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      if (dropped.kind === "gap") {
        // An older gap being dropped is not history being lost twice: carry its
        // span into the one we are about to write.
        if (dropped.reason === "ring_overflow") {
          fromSeq = Math.min(fromSeq ?? dropped.fromSeq, dropped.fromSeq);
          toSeq = Math.max(toSeq ?? dropped.toSeq, dropped.toSeq);
        }
        continue;
      }
      // Dropping a row drops its artifacts' claim on the store too; the payload
      // is released so a long session's pictures do not outlive the rows that
      // named them.
      if (dropped.artifacts) {
        for (const ref of Object.values(dropped.artifacts)) {
          if (!ref) continue;
          this.releaseArtifact(ref.id);
          // Forgotten with the row that named it, so the id set cannot grow
          // without bound across a long session. A fetch for it then answers
          // 404 — which is right: the row it belonged to is gone too.
          this.knownArtifacts.delete(ref.id);
        }
      }
      fromSeq = Math.min(fromSeq ?? dropped.seq, dropped.seq);
      toSeq = Math.max(toSeq ?? dropped.seq, dropped.seq);
    }
    if (fromSeq === undefined || toSeq === undefined) return;
    const head = this.entries[0];
    if (head?.kind === "gap" && head.reason === "ring_overflow") {
      head.fromSeq = Math.min(head.fromSeq, fromSeq);
      head.toSeq = Math.max(head.toSeq, toSeq);
      head.seq = head.toSeq;
      return;
    }
    this.entries.unshift({
      kind: "gap",
      seq: toSeq,
      bootId: this.bootId,
      ts: Date.now(),
      fromSeq,
      toSeq,
      reason: "ring_overflow",
    });
  }

  /**
   * Lift the page-derived payloads out of a result and into the artifact store.
   *
   * They leave the ROW because a row is metadata a UI lists a hundred at a time
   * and a screenshot is a hundred kilobytes. The row keeps the id, the size and
   * the media type — enough to render "screenshot, 84 KB" and fetch it on
   * demand.
   */
  private storeArtifacts(
    output: Record<string, unknown> | undefined,
  ): BrowserLedgerRow["artifacts"] {
    if (!output) return undefined;
    const artifacts: NonNullable<BrowserLedgerRow["artifacts"]> = {};
    const screenshot = output.screenshot;
    if (typeof screenshot === "string" && screenshot) {
      artifacts.screenshot = this.put(screenshot, "image/jpeg", "base64");
    }
    const a11y = output.a11y;
    if (typeof a11y === "string" && a11y) {
      artifacts.a11y = this.put(a11y, "text/plain", "utf8");
    }
    const text = output.text;
    if (typeof text === "string" && text) {
      artifacts.text = this.put(text, "text/plain", "utf8");
    }
    return artifacts;
  }

  private put(
    data: string,
    mediaType: string,
    encoding: "base64" | "utf8",
  ): BrowserLedgerArtifactRef {
    const id = this.mintId();
    this.knownArtifacts.add(id);
    const bytes =
      encoding === "base64"
        ? Math.floor((data.length * 3) / 4)
        : Buffer.byteLength(data, "utf8");
    // A single artifact larger than the whole budget is recorded as evicted
    // rather than stored: keeping it would evict everything else to hold one
    // picture, and refusing to record it at all would hide that it existed.
    if (bytes > this.maxArtifactBytes) {
      return { id, bytes, mediaType, evicted: true };
    }
    this.artifacts.set(id, { id, mediaType, encoding, data, bytes });
    this.artifactBytes += bytes;
    this.evictArtifacts();
    return { id, bytes, mediaType };
  }

  private evictArtifacts(): void {
    // Insertion-ordered: `Map` iteration gives the oldest first, which is the
    // one whose row a mirror has had the longest to collect.
    while (
      this.artifacts.size > this.maxArtifacts ||
      this.artifactBytes > this.maxArtifactBytes
    ) {
      const oldest = this.artifacts.keys().next();
      if (oldest.done) break;
      const id = oldest.value;
      this.releaseArtifact(id);
      // The ROW keeps its descriptor and is marked evicted, so the trace still
      // says a screenshot was taken and that the picture is gone.
      for (const entry of this.entries) {
        if (entry.kind !== "command" || !entry.artifacts) continue;
        for (const ref of Object.values(entry.artifacts)) {
          if (ref?.id === id) ref.evicted = true;
        }
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
