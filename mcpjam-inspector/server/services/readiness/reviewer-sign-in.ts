/**
 * The reviewer sign-in rehearsal: MCPJam signs in as a directory's reviewer
 * from a clean hosted browser, records each stage on the reviewer attempt,
 * and connects the reviewer account the reviewer-path checks then use.
 *
 * Model-free and scripted, in the injected-seam form of
 * `browserd/hosted-browser-synthetic.ts`: the credentials, the desktop, the
 * page, the connection request and the attempt arrive as seams, so every
 * stage, and the release after it, is testable without E2B or the backend.
 * The live seams are built in `reviewer-sign-in-live.ts`.
 *
 * THE DESKTOP IS RELEASED ON EVERY OUTCOME, in a `finally`, including a
 * thrown error and a lost lease: MCPJam pays for it by the minute.
 *
 * NO CREDENTIAL IS WRITTEN DOWN. A value reaches the browser daemon only
 * beside a command whose text is its `{{secret:NAME}}` placeholder, limited to
 * the authorization server's origin, and only on a daemon that enforces that
 * limit (`secret-origins`). Text from the page or an error is scrubbed of the
 * values before it is recorded or logged, and keeps only the origin of a URL.
 *
 * SCOPE. AuthKit-hosted sign-in is the supported path; on any other provider
 * the pages are read by a conservative heuristic and each stage says it was
 * approximated. The signed-in identity is never read from the consent page:
 * the identity check asks the server itself.
 */
import { createSecretScrubber } from "../../../shared/secret-scrubber.js";
import { redactForLog } from "../../routes/v1/redact-log-message.js";
import { logger } from "../../utils/logger.js";
import type { BrowserCommandSecret } from "../browserd/protocol.js";
import { abortable } from "../sessionSimulation/target-discovery.js";
import {
  isAuthKitOrigin,
  readSignInPage,
  type SignInPage,
} from "./reviewer-sign-in-pages.js";
import { ReadinessLeaseLostError } from "./runner.js";

export type ReviewerStageName =
  | "credentials"
  | "connect-link"
  | "sign-in"
  | "verification"
  | "consent"
  | "connected";

/** One stage, in the shape the attempt's run route takes it. */
export interface ReviewerStage {
  stage: ReviewerStageName;
  status: "passed" | "failed" | "blocked" | "skipped";
  detail?: string;
  evidence?: { screenshotArtifactId?: string; recordingArtifactId?: string };
}

/** One write to the attempt. A stop for a person and an outcome are exclusive. */
export interface ReviewerAttemptWrite {
  stage?: ReviewerStage;
  reviewerAccountId?: string;
  waitingFor?: { reason: string; action: string };
  outcome?: "passed" | "failed";
  detail?: string;
}

/** The attempt as the rehearsal reads it: secret NAMES, never a value. */
export interface ReviewerAttemptView {
  projectId: string;
  reviewerAccountId?: string;
  humanSignInCompletedAt?: number;
  passwordSecretName: string;
  usernameSecretName?: string;
  username?: string;
}

export interface SignInBrowser {
  /** What the daemon announced; a sign-in needs `secret-origins` and `navigation-stop`. */
  readonly features: readonly string[];
  open(url: string): Promise<void>;
  read(): Promise<SignInPage>;
  /** Type into a control; placeholders in `text` resolve in the daemon. */
  type(
    ref: string,
    text: string,
    options: { secrets: BrowserCommandSecret[]; submit: boolean },
  ): Promise<void>;
  click(ref: string): Promise<void>;
  /** Where this moment can be seen again, or nothing without a recording. */
  screenshot(): Promise<string | undefined>;
}

export interface ReviewerConnectLink {
  authorizationUrl: string;
  /** The one origin the reviewer's credentials may be typed on. */
  authorizationServerOrigin: string;
  /** MCPJam's callback page, where the authorization server sends the answer. */
  callbackUrl: string;
}

export interface ReviewerCallback {
  state: string;
  code?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
}

export interface ReviewerSignInDeps {
  /** Lease-guarded writes to the attempt; a lost lease throws. */
  record(write: ReviewerAttemptWrite): Promise<void>;
  /** The values for these names, or why they cannot be had. */
  secrets(
    names: string[],
  ): Promise<
    { values: { name: string; value: string }[] } | { unavailable: string }
  >;
  desktop: {
    reserve(signal: AbortSignal): Promise<{
      browser: SignInBrowser;
      /** Where the run's recording will be read, kept on every stage. */
      recordingArtifactId?: string;
    }>;
    /** Collect the recording and release the desktop. Safe to call again. */
    release(): Promise<void>;
  };
  connect: {
    prepare(signal: AbortSignal): Promise<ReviewerConnectLink>;
    complete(
      callback: ReviewerCallback,
      signal: AbortSignal,
    ): Promise<{ accountId: string } | { failed: string }>;
  };
  sleep?: (ms: number) => Promise<void>;
}

export type ReviewerSignInOutcome =
  | { kind: "connected"; reviewerAccountId: string }
  | { kind: "failed"; detail: string }
  | { kind: "waiting-for-person"; reason: string; action: string };

/** Desktop boot, discovery, a two-step sign-in and consent fit well inside. */
export const REVIEWER_SIGN_IN_TIMEOUT_MS = 6 * 60_000;
/** R5's label for a stage read off another provider's page. */
export const APPROXIMATED_PREFIX = "Approximated: ";
const MAX_PAGE_READS = 12;
const UNRECOGNIZED_RETRIES = 3;
const SETTLE_WAIT_MS = 1_500;
const PAGE_STAGES = new Set(["sign-in", "verification", "consent"]);
const START_AGAIN = "Start a new attempt.";
const PERSON_SIGN_IN =
  "Open Finish reviewer sign-in on the submission, complete the sign-in, then resume this attempt.";

type Scrub = (text: string) => string;

/** The last write, and what the run learns. */
interface Ending {
  write: ReviewerAttemptWrite;
  outcome: ReviewerSignInOutcome;
}

/** End the attempt as failed or, given an `action`, stop it for a person. */
function ending(stage: ReviewerStage, action?: string): Ending {
  const detail = stage.detail ?? "";
  if (action) {
    const waitingFor = { reason: detail, action };
    return {
      write: { stage, waitingFor },
      outcome: { kind: "waiting-for-person", ...waitingFor },
    };
  }
  return {
    write: { stage, outcome: "failed", detail },
    outcome: { kind: "failed", detail },
  };
}

/** Values back to placeholders, and of any URL only its origin. */
function scrubberFor(values: { name: string; value: string }[]): Scrub {
  const scrubber = createSecretScrubber(values, {
    replacement: (name) => `{{secret:${name}}}`,
  });
  return (text) =>
    (scrubber ? scrubber.scrubString(text) : text).replace(
      /\bhttps?:\/\/[^\s"'<>)]+/gi,
      originOf,
    );
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "[address]";
  }
}

/** An error as one scrubbed sentence. */
const said = (error: unknown, scrub: Scrub) =>
  scrub(redactForLog(error)).replace(/[.\s]*$/, ".");

interface Drive {
  deps: ReviewerSignInDeps;
  browser: SignInBrowser;
  link: ReviewerConnectLink;
  attempt: ReviewerAttemptView;
  values: { name: string; value: string }[];
  recordingArtifactId?: string;
  signal: AbortSignal;
  scrub: Scrub;
}

/** A stage with its evidence, labelled when the page was read by heuristic. */
async function stageOf(
  drive: Drive,
  stage: ReviewerStageName,
  status: ReviewerStage["status"],
  detail: string,
  frame = true,
): Promise<ReviewerStage> {
  let shot: string | undefined;
  try {
    shot = frame ? await drive.browser.screenshot() : undefined;
  } catch {
    // A frame that cannot be pointed at costs the stage its picture, not its record.
  }
  const evidence = {
    ...(shot ? { screenshotArtifactId: shot } : {}),
    ...(drive.recordingArtifactId
      ? { recordingArtifactId: drive.recordingArtifactId }
      : {}),
  };
  const approximated =
    PAGE_STAGES.has(stage) &&
    !isAuthKitOrigin(drive.link.authorizationServerOrigin);
  return {
    stage,
    status,
    detail: `${approximated ? APPROXIMATED_PREFIX : ""}${detail}`,
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
  };
}

const record = (drive: Drive, stage: ReviewerStage) =>
  abortable(drive.deps.record({ stage }), drive.signal);

/** The text to type, and the one value the daemon may put in its place. */
function credential(drive: Drive, which: "username" | "password") {
  const name =
    which === "password"
      ? drive.attempt.passwordSecretName
      : drive.attempt.usernameSecretName;
  if (!name) {
    const plain = drive.attempt.username;
    return plain === undefined ? undefined : { text: plain, secrets: [] };
  }
  const value = drive.values.find((entry) => entry.name === name)?.value;
  if (value === undefined) return undefined;
  const origins = [drive.link.authorizationServerOrigin];
  return { text: `{{secret:${name}}}`, secrets: [{ name, value, origins }] };
}

/** Hand what the redirect carried to the connection; the URL goes nowhere. */
async function finishConnect(
  drive: Drive,
  params: URLSearchParams,
): Promise<Ending> {
  const param = (key: string) => params.get(key) || undefined;
  const state = param("state");
  if (!state) {
    return ending(
      await stageOf(
        drive,
        "connected",
        "failed",
        `The reviewer account was not connected because MCPJam's callback page did not receive the authorization result. ${START_AGAIN}`,
        false,
      ),
    );
  }
  const callback = {
    state,
    code: param("code"),
    iss: param("iss"),
    error: param("error"),
    errorDescription: param("error_description"),
  };
  const answer = await abortable(
    drive.deps.connect.complete(callback, drive.signal),
    drive.signal,
  );
  if ("failed" in answer) {
    const why = drive.scrub(answer.failed).replace(/[.\s]*$/, ".");
    return ending(
      await stageOf(
        drive,
        "connected",
        "failed",
        `The reviewer account was not connected. ${why} ${START_AGAIN}`,
        false,
      ),
    );
  }
  const detail =
    "MCPJam signed in as the reviewer and connected the reviewer account.";
  return {
    write: {
      stage: await stageOf(drive, "connected", "passed", detail, false),
      reviewerAccountId: answer.accountId,
    },
    outcome: { kind: "connected", reviewerAccountId: answer.accountId },
  };
}

async function drivePages(drive: Drive): Promise<Ending> {
  const { browser, link, signal, scrub } = drive;
  const stop = async (
    stage: ReviewerStageName,
    status: ReviewerStage["status"],
    detail: string,
    action?: string,
  ) => ending(await stageOf(drive, stage, status, detail), action);
  const typed = new Set<"username" | "password">();
  let signedIn = false;
  let unrecognized = 0;
  for (let read = 0; read < MAX_PAGE_READS; read += 1) {
    const seen = readSignInPage(await abortable(browser.read(), signal), {
      callbackUrl: link.callbackUrl,
      authKit: isAuthKitOrigin(link.authorizationServerOrigin),
      submitted: typed.size > 0,
    });
    // The password went in and the page moved past the form: it was accepted.
    const movedOn = ["callback", "verification", "consent"].includes(seen.kind);
    if (movedOn && typed.has("password") && !signedIn) {
      signedIn = true;
      const detail = "MCPJam signed in with the reviewer's saved credentials.";
      await record(drive, await stageOf(drive, "sign-in", "passed", detail));
    }
    if (seen.kind === "callback") return finishConnect(drive, seen.params);
    // A form asking again for what was just submitted is refusing it.
    const again =
      seen.kind === "credentials" &&
      (seen.password
        ? typed.has("password")
        : Boolean(seen.username) && typed.has("username"));
    if (seen.kind === "refused" || again) {
      const quote =
        seen.kind === "refused"
          ? `"${scrub(seen.quote)}"`
          : `it asked for the ${seen.kind === "credentials" && seen.password ? "password" : "username"} again`;
      return stop(
        "sign-in",
        "failed",
        `The sign-in page refused the reviewer's credentials: ${quote}. Check the saved username and password, then ${START_AGAIN.toLowerCase()}`,
      );
    }
    if (seen.kind === "verification") {
      return stop(
        "verification",
        "blocked",
        `The sign-in page asked for a verification step MCPJam cannot complete: "${scrub(seen.quote)}".`,
        "Open Finish reviewer sign-in on the submission, complete the verification, then resume this attempt.",
      );
    }
    if (seen.kind === "consent") {
      if (!seen.approve) {
        return stop(
          "consent",
          "blocked",
          "MCPJam could not tell which control on the consent page approves access, so it clicked none.",
          "Open Finish reviewer sign-in on the submission, approve access, then resume this attempt.",
        );
      }
      const detail = `MCPJam approved access on the consent page ("${scrub(seen.approve.name)}").`;
      await record(drive, await stageOf(drive, "consent", "passed", detail));
      await abortable(browser.click(seen.approve.ref), signal);
      continue;
    }
    if (seen.kind === "credentials") {
      // One field per read: typing can re-render the form, and the next read
      // hands out fresh refs.
      const which =
        seen.username && !typed.has("username") ? "username" : "password";
      const control = seen[which];
      const typing = credential(drive, which);
      if (!control || !typing) {
        return stop(
          "sign-in",
          "blocked",
          `The sign-in page asked for a ${which}, and this attempt has none saved.`,
          PERSON_SIGN_IN,
        );
      }
      typed.add(which);
      // A username alone is its own step: AuthKit asks for the email first.
      const submit = which === "password" || !seen.password;
      await abortable(
        browser.type(control.ref, typing.text, {
          secrets: typing.secrets,
          submit,
        }),
        signal,
      );
      continue;
    }
    unrecognized += 1;
    if (unrecognized > UNRECOGNIZED_RETRIES) break;
    // A redirect in flight reads as no page at all; give it a moment.
    await abortable((drive.deps.sleep ?? pause)(SETTLE_WAIT_MS), signal);
  }
  return stop(
    "sign-in",
    "blocked",
    "MCPJam did not recognize a page in the sign-in, so it stopped.",
    PERSON_SIGN_IN,
  );
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reserve, check, connect and drive; the caller releases. */
async function rehearse(
  deps: ReviewerSignInDeps,
  base: Pick<Drive, "attempt" | "values" | "signal" | "scrub">,
): Promise<Ending> {
  const { signal, scrub } = base;
  const blocked = (detail: string) =>
    ending({ stage: "sign-in", status: "blocked", detail });
  let reserved: Awaited<ReturnType<ReviewerSignInDeps["desktop"]["reserve"]>>;
  try {
    reserved = await abortable(deps.desktop.reserve(signal), signal);
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError || signal.aborted) throw error;
    return blocked(
      `MCPJam could not get a hosted browser for the sign-in: ${said(error, scrub)} ${START_AGAIN}`,
    );
  }
  const { browser, recordingArtifactId } = reserved;
  if (!browser.features.includes("secret-origins")) {
    return blocked(
      "This hosted browser cannot limit the reviewer's credentials to the sign-in page, so MCPJam did not type them. Start a new attempt after MCPJam updates its hosted browser.",
    );
  }
  // Without a stop at MCPJam's callback, its app would take the code before
  // this run could read it, so nothing is started.
  if (!browser.features.includes("navigation-stop")) {
    return ending({
      stage: "connected",
      status: "failed",
      detail:
        "This hosted browser cannot stop at MCPJam's callback page, so MCPJam could not finish the reviewer's connection and did not sign in. Start a new attempt after MCPJam updates its hosted browser.",
    });
  }
  let link: ReviewerConnectLink;
  try {
    link = await abortable(deps.connect.prepare(signal), signal);
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError || signal.aborted) throw error;
    return ending({
      stage: "connect-link",
      status: "failed",
      detail: `MCPJam could not prepare the reviewer's connection: ${said(error, scrub)} ${START_AGAIN}`,
    });
  }
  const drive: Drive = { ...base, deps, browser, link, recordingArtifactId };
  // Only the authorization server's own page is ever opened.
  await abortable(browser.open(link.authorizationUrl), signal);
  const detail =
    "MCPJam opened the authorization server's sign-in page in a clean browser.";
  await record(drive, await stageOf(drive, "connect-link", "passed", detail));
  return drivePages(drive);
}

/** Write the last stage with the outcome; a lost lease still throws. */
async function end(
  deps: ReviewerSignInDeps,
  result: Ending,
  scrub: Scrub,
): Promise<ReviewerSignInOutcome> {
  try {
    await deps.record(result.write);
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError) throw error;
    // The attempt was cancelled or taken over meanwhile; what this run
    // learned still decides how it goes on.
    logger.warn("[readiness] the sign-in outcome was not recorded", {
      error: said(error, scrub),
    });
  }
  return result.outcome;
}

/**
 * Rehearse the reviewer's sign-in for a run that joined `attempt`.
 *
 * Throws only for a lost lease or the caller's own abort: every other failure
 * becomes a recorded stage and a `failed` outcome, and the run goes on to
 * grade the submission without the reviewer account.
 */
export async function rehearseReviewerSignIn(
  deps: ReviewerSignInDeps,
  attempt: ReviewerAttemptView,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<ReviewerSignInOutcome> {
  const timeoutMs = options.timeoutMs ?? REVIEWER_SIGN_IN_TIMEOUT_MS;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const names = [attempt.usernameSecretName, attempt.passwordSecretName].filter(
    (name): name is string => name !== undefined,
  );
  const secrets = await deps.secrets(names);
  if ("unavailable" in secrets) {
    const stage = { stage: "credentials", status: "blocked" } as const;
    const scrub = scrubberFor([]);
    const detail = scrub(secrets.unavailable);
    return end(deps, ending({ ...stage, detail }), scrub);
  }
  const scrub = scrubberFor(secrets.values);
  let result: Ending;
  try {
    result = await rehearse(deps, {
      attempt,
      values: secrets.values,
      signal,
      scrub,
    });
  } catch (error) {
    if (error instanceof ReadinessLeaseLostError || options.signal.aborted) {
      throw error;
    }
    const why = signal.aborted
      ? `The sign-in did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`
      : `The sign-in stopped on an error: ${said(error, scrub)}`;
    result = ending({
      stage: "sign-in",
      status: "failed",
      detail: `${why} ${START_AGAIN}`,
    });
  } finally {
    try {
      await deps.desktop.release();
    } catch (error) {
      // The backend also releases a run's desktop when the run ends or is
      // re-queued, so a failed release costs minutes, not a leaked box.
      logger.warn("[readiness] releasing the sign-in desktop failed", {
        error: said(error, scrub),
      });
    }
  }
  return end(deps, result, scrub);
}
