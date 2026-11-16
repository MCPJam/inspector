/**
 * Where one stage of a reviewer sign-in ends, and the picture that shows it,
 * read off the browser tools' results while the agent works.
 *
 * STAGES COME FROM WHAT MCPJAM OBSERVES, never from the model's account of
 * them: the sign-in ends at the first look at a new page after the password
 * was typed (or at the callback), consent at the callback, and a stop where
 * the agent stops.
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

export class SignInEvidence {
  private newest: Image | "suppressed" | undefined;
  private typedSinceFrame = false;
  private lastUrl: string | undefined;
  /** The page the password went in on, until the sign-in stage closes. */
  private passwordOn: string | undefined;
  private signInClosed = false;
  /** The page moved on after the password; closes at the next picture. */
  private movedOn = false;
  private actsSinceSignIn = 0;

  constructor(
    private readonly store: (image: Image) => Promise<string | undefined>,
    private readonly onSignedIn: () => Promise<void>,
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
              await this.saw(name, result);
              return result;
            },
          },
        ];
      }),
    );
  }

  /** A credential reached a field: what was pictured before it is stale. */
  typed(password: boolean) {
    this.newest = undefined;
    this.typedSinceFrame = true;
    if (password && !this.signInClosed) this.passwordOn = this.lastUrl ?? "";
  }

  /** Whether the agent acted after the sign-in, which makes consent a stage. */
  get actedAfterSignIn() {
    return this.signInClosed && this.actsSinceSignIn > 0;
  }

  get signedIn() {
    return this.signInClosed;
  }

  /** Close the stage now, with its own picture, and start the next one. */
  async close(
    stage: ReviewerStage["stage"],
    status: ReviewerStage["status"],
    detail: string,
  ): Promise<ReviewerStage> {
    const evidence = await this.evidence();
    this.newest = undefined;
    this.typedSinceFrame = false;
    if (stage === "sign-in") this.signInClosed = true;
    return { stage, status, detail, evidence };
  }

  private async evidence(): Promise<Evidence> {
    const newest = this.newest;
    if (newest === "suppressed" || (!newest && this.typedSinceFrame)) {
      return { screenshotStatus: "suppressed", screenshotNote: SUPPRESSED_NOTE };
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

  private async saw(tool: string, result: unknown) {
    const output = record(result);
    const raw = screenshotOf(result);
    const image = raw ? capture(raw) : undefined;
    if (image) {
      this.newest = image;
      this.typedSinceFrame = false;
    } else if (output?.screenshotSuppressed === true) {
      this.newest = "suppressed";
    }
    const url = urlOf(result);
    if (url) this.lastUrl = url;
    if (this.signInClosed && tool === "browser_act") this.actsSinceSignIn += 1;
    if (this.passwordOn !== undefined && url && url !== this.passwordOn) {
      this.movedOn = true;
    }
    // The page moved on after the password went in: the sign-in is done, and
    // the first look at the new page is its picture.
    if (this.movedOn && !this.signInClosed && this.newest) {
      await this.onSignedIn();
    }
  }
}
