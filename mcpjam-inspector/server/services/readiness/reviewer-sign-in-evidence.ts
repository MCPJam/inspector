/**
 * Where one stage of a reviewer sign-in ends, and the picture that shows it,
 * read off the browser tools' results while the agent works.
 *
 * STAGES COME FROM WHAT MCPJAM OBSERVES, never from the model's account of
 * them. A page that moves on after the password is PROGRESS, not a sign-in:
 * it may be an error page, a verification step or the consent screen. The
 * first look at it is kept as the sign-in's picture, and what follows belongs
 * to the next stage. The sign-in passes only once MCPJam's callback carries a
 * code (see `reviewer-sign-in-agent.ts`), and a stop is where the agent stops.
 *
 * A STAGE'S PICTURE IS ITS OWN. The newest frame since the stage began, or,
 * once a credential was typed and nothing safe has been pictured since, none:
 * the stage says `suppressed` rather than show the form as it was before the
 * credential went in. With no frame at all it says `unavailable`.
 */
import type { ToolSet } from "ai";
import { capture, screenshotOf } from "../browser-tool-evidence.js";
import type { ReviewerStage } from "./reviewer-sign-in.js";

type Image = NonNullable<ReturnType<typeof capture>>;
type Evidence = NonNullable<ReviewerStage["evidence"]>;

export const SUPPRESSED_NOTE =
  "A credential was typed on this page, so MCPJam did not picture it.";
const NO_FRAME_NOTE = "No picture was taken during this step.";
const NOT_STORED_NOTE = "The picture could not be stored.";

const record = (value: unknown) =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

/** The page a tool result shows, if it says. */
function urlOf(result: unknown): string | undefined {
  const top = record(result);
  const url = top?.url ?? record(top?.page)?.url;
  return typeof url === "string" ? url : undefined;
}

/** The frames of one stage: its newest picture, and whether a credential went in since. */
interface Segment {
  newest: Image | "suppressed" | undefined;
  typedSinceFrame: boolean;
}

const fresh = (): Segment => ({ newest: undefined, typedSinceFrame: false });

export class SignInEvidence {
  private segment: Segment = fresh();
  /** The sign-in's own frames, held once the page moved on after the password. */
  private signInSegment: Segment | undefined;
  private lastUrl: string | undefined;
  /** The page the password went in on, until the page moves on. */
  private passwordOn: string | undefined;
  /** The page moved on after the password: progress, before any picture of it. */
  private movedOn = false;
  private actsAfterProgress = 0;

  constructor(
    private readonly store: (image: Image) => Promise<string | undefined>,
  ) {}

  /** The tools, each result read here before it goes back to the model. */
  wrap(tools: ToolSet): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute) return [name, definition];
        return [
          name,
          {
            ...definition,
            execute: async (
              input: unknown,
              options: Parameters<NonNullable<typeof execute>>[1],
            ) => {
              const result = await execute(input as never, options);
              this.saw(name, result);
              return result;
            },
          },
        ];
      }),
    );
  }

  /** A credential reached a field: what was pictured before it is stale. */
  typed(password: boolean) {
    this.segment = { newest: undefined, typedSinceFrame: true };
    if (password && !this.progressed) this.passwordOn = this.lastUrl ?? "";
  }

  /** Whether the page moved on after the password: progress, not a sign-in. */
  get progressed() {
    return this.movedOn;
  }

  /** Whether the agent acted after that, which makes consent a stage. */
  get actedAfterProgress() {
    return this.progressed && this.actsAfterProgress > 0;
  }

  /**
   * Close the stage now, with its own picture, and start the next one. The
   * sign-in keeps the picture held when the page moved on, if it did.
   */
  async close(
    stage: ReviewerStage["stage"],
    status: ReviewerStage["status"],
    detail: string,
  ): Promise<ReviewerStage> {
    const held = stage === "sign-in" ? this.signInSegment : undefined;
    const evidence = await this.evidence(held ?? this.segment);
    if (held) this.signInSegment = fresh();
    else this.segment = fresh();
    return { stage, status, detail, evidence };
  }

  private async evidence({
    newest,
    typedSinceFrame,
  }: Segment): Promise<Evidence> {
    if (newest === "suppressed" || (!newest && typedSinceFrame)) {
      return {
        screenshotStatus: "suppressed",
        screenshotNote: SUPPRESSED_NOTE,
      };
    }
    if (!newest) {
      return { screenshotStatus: "unavailable", screenshotNote: NO_FRAME_NOTE };
    }
    let id: string | undefined;
    try {
      id = await this.store(newest);
    } catch {
      // A picture that cannot be kept costs the stage its picture, not its record.
      id = undefined;
    }
    return id
      ? { screenshotArtifactId: id, screenshotStatus: "captured" }
      : { screenshotStatus: "unavailable", screenshotNote: NOT_STORED_NOTE };
  }

  private saw(tool: string, result: unknown) {
    const output = record(result);
    const raw = screenshotOf(result);
    const image = raw ? capture(raw) : undefined;
    // An act after the page moved on begins the next stage: the sign-in keeps
    // what it had, and this act's picture is the next stage's.
    if (this.movedOn && tool === "browser_act") {
      if (!this.signInSegment) this.holdSignIn();
      this.actsAfterProgress += 1;
    }
    if (image) this.segment = { newest: image, typedSinceFrame: false };
    else if (output?.screenshotSuppressed === true)
      this.segment.newest = "suppressed";
    const url = urlOf(result);
    if (url) this.lastUrl = url;
    if (this.passwordOn !== undefined && url && url !== this.passwordOn) {
      this.movedOn = true;
    }
    // The first safe look at the page after the password is the sign-in's
    // picture, held until the sign-in closes. A suppressed one is not: a
    // later look before the next act still can be. Nothing passes here.
    if (this.movedOn && !this.signInSegment && image) this.holdSignIn();
  }

  private holdSignIn() {
    this.signInSegment = this.segment;
    this.segment = fresh();
  }
}
