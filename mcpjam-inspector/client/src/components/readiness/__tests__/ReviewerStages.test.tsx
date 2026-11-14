/**
 * The reviewer path after the credentials, on Test & launch: each stage of
 * the sign-in with its frame of the run's recording, who the identity check
 * found, and the handover when the rehearsal stops for a person. Only the
 * API, the Convex read and the secrets hooks are faked.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CONNECTOR_FLOW, type PlacedStep } from "@mcpjam/sdk/browser";
import type { ProjectSecretView } from "@/hooks/useProjectSecrets";
import type { ReviewerAttempt } from "@/lib/apis/reviewer-attempts-api";
import { ReviewerSection } from "../ReviewerSection";
import type { ReservationView } from "../ReviewerStages";
import {
  ACTION,
  ASKED,
  attemptIn,
  CONNECTED,
  EMAIL_SECRET,
  OPENED,
  PASSED,
  PASSWORD_SECRET,
  REFUSED,
  REFUSED_DETAIL,
  RESERVATION,
  SCOPE,
  secretRow,
  SIGNED_IN,
  stage,
  VERIFIED,
  WAITING,
  WRONG_TENANT,
} from "./reviewer-fixtures";

const api = vi.hoisted(() => ({
  getLatestReviewerAttempt: vi.fn(),
  startReviewerAttempt: vi.fn(),
  resumeReviewerAttempt: vi.fn(),
  cancelReviewerAttempt: vi.fn(),
  createReviewerHandoff: vi.fn(),
}));
vi.mock("@/lib/apis/reviewer-attempts-api", () => api);

const world = vi.hoisted(() => ({
  rows: [] as ProjectSecretView[] | undefined,
  /** What the run's desktop reservations read as, or a thrown read. */
  views: undefined as ReservationView[] | undefined | Error,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({ canManageMembers: true, isLoading: false }),
}));
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => world.rows,
  useCreateProjectSecret: () => vi.fn(),
  useUpdateProjectSecret: () => vi.fn(),
}));
const read = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: read.useQuery,
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TEST_LAUNCH = CLAUDE_CONNECTOR_FLOW.steps.find(
  (entry) => entry.id === "testLaunch",
);
if (!TEST_LAUNCH) throw new Error("The Claude flow has no Test & launch step");
const RECORDING_URL = "https://example.convex.site/web/artifact?t=sample";
const KEPT: ReservationView[] = [
  {
    reservationId: RESERVATION,
    recording: { url: RECORDING_URL, meta: { durationMs: 48_000 } },
  },
];

function renderPath(attempt: ReviewerAttempt | null, steps: PlacedStep[] = []) {
  api.getLatestReviewerAttempt.mockResolvedValue(attempt);
  return render(
    <ReviewerSection
      {...SCOPE}
      step={TEST_LAUNCH!}
      values={{}}
      onAnswer={vi.fn()}
      steps={steps}
    />,
  );
}

const region = () => screen.getByRole("region", { name: "Reviewer path" });
/** The path's rows, each as its visible text. */
async function rows() {
  const list = await within(region()).findByRole("list");
  return within(list).getAllByRole("listitem");
}
const rowNamed = async (label: string) => {
  const found = (await rows()).find((row) => row.textContent?.includes(label));
  if (!found) throw new Error(`No row ${label}`);
  return within(found);
};

describe("the reviewer path's stages", () => {
  let pause: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    world.rows = [secretRow(EMAIL_SECRET), secretRow(PASSWORD_SECRET)];
    world.views = KEPT;
    read.useQuery.mockReset().mockImplementation(() => {
      if (world.views instanceof Error) throw world.views;
      return world.views;
    });
    pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => undefined);
  });
  afterEach(() => pause.mockRestore());

  it("a full rehearsal: each stage in words, the identity once, and one recording its frames open", async () => {
    renderPath(PASSED, VERIFIED);
    await waitFor(async () => expect(await rows()).toHaveLength(6));
    // Frames come once the run's recording is read.
    const recording = await within(region()).findByRole("button", {
      name: "Recording 0:48",
    });
    const texts = (await rows()).map((row) => row.textContent);
    expect(texts).toEqual([
      expect.stringContaining("Reviewer credentials"),
      `2Sign-in page${OPENED.detail}ScreenshotEstablished`,
      `3Fresh sign-in${SIGNED_IN.detail}ScreenshotEstablished`,
      expect.stringMatching(
        /^4Consent screenMCPJam approved access .*ScreenshotEstablished$/,
      ),
      `5Reviewer connection${CONNECTED.detail}Established`,
      "6Identity and tenantget_me answers as review@example.com in Review Org.Established",
    ]);
    expect(within(region()).getAllByText(/review@example\.com/)).toHaveLength(
      1,
    );
    expect(read.useQuery).toHaveBeenCalledWith(expect.anything(), {
      runId: "run_1",
    });

    // The recording appears once, closed until asked for.
    expect(recording).toHaveAttribute("aria-expanded", "false");
    expect(within(region()).queryByLabelText(/^Recording of/)).toBeNull();

    // A frame is the recording paused at its moment.
    await userEvent.click(
      screen.getByRole("button", { name: "Screenshot of Fresh sign-in" }),
    );
    const video = within(region()).getByLabelText(
      "Recording of the reviewer sign-in",
    ) as HTMLVideoElement;
    expect(video).toHaveAttribute("src", RECORDING_URL);
    expect(within(region()).getAllByLabelText(/^Recording of/)).toHaveLength(1);
    fireEvent(video, new Event("loadedmetadata"));
    expect(video.currentTime).toBe(9.4);
    expect(pause).toHaveBeenCalled();

    // Loaded, a second frame seeks at once.
    Object.defineProperty(video, "readyState", { value: 1 });
    await userEvent.click(
      screen.getByRole("button", { name: "Screenshot of Consent screen" }),
    );
    expect(video.currentTime).toBe(14.8);
  });

  it("an approximated consent: labelled, in the rehearsal's words without the prefix", async () => {
    const detail = 'MCPJam approved access on the consent page ("Authorize").';
    renderPath(
      attemptIn("passed", {
        stages: [
          OPENED,
          SIGNED_IN,
          stage("consent", "passed", `Approximated: ${detail}`, 12),
          CONNECTED,
        ],
      }),
    );
    const consent = await rowNamed("Consent screen");
    expect(consent.getByText("Approximated")).toBeVisible();
    expect(consent.getByText(detail)).toBeVisible();
    expect(within(region()).queryByText(/Approximated: /)).toBeNull();
    expect(within(region()).getAllByText("Approximated")).toHaveLength(1);
  });

  it("opens a requester-only sign-in link for the paused attempt", async () => {
    const url = "https://app.example.com/connect/server/one-use";
    api.createReviewerHandoff.mockResolvedValue({ handoffUrl: url, expiresAt: 100 });
    renderPath(WAITING);
    await userEvent.click(await screen.findByRole("button", { name: "Finish reviewer sign-in" }));
    expect(api.createReviewerHandoff).toHaveBeenCalledWith(SCOPE, WAITING.id);
    expect(await screen.findByRole("link", { name: "Open reviewer sign-in" })).toHaveAttribute("href", url);
  });

  it("shows a completed human sign-in before the same attempt resumes", async () => {
    renderPath({ ...WAITING, reviewerAccountId: "reviewer_1", humanSignInCompletedAt: 100 });
    expect(await screen.findByText("Reviewer sign-in completed. Resume this attempt to run the checks.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Finish reviewer sign-in" })).toBeNull();
  });

  it("a verification stop: the step waits for a person, and the handover says what, who and what works", async () => {
    renderPath(WAITING);
    const verification = await rowNamed("Verification");
    expect(verification.getByText("Needs a person")).toBeVisible();
    expect(
      (await rowNamed("Consent screen")).getByText("Blocked"),
    ).toBeVisible();

    const handover = within(
      screen.getByText("What the page asked for").closest("dl") as HTMLElement,
    );
    expect(
      handover.getByText("What the page asked for").nextElementSibling,
    ).toHaveTextContent(ASKED);
    const who = handover.getByText("Who can finish it");
    expect(who.nextElementSibling).toHaveTextContent(
      "The person who started this sign-in.",
    );
    expect(who.nextElementSibling?.nextElementSibling).toHaveTextContent(
      "Open Finish reviewer sign-in, complete the verification, then resume this attempt.",
    );
    // The rehearsal's own advice, to sign in as the reviewer elsewhere, changes
    // nothing for the attempt, so the page does not repeat it.
    expect(screen.queryByText(ACTION)).toBeNull();
    expect(
      handover.getByText(
        "A teammate or an agent can resume this attempt with its id.",
      ),
    ).toBeVisible();
    expect(handover.getByText("att_1")).toBeVisible();
    expect(
      handover.getByRole("button", { name: "Copy resume command" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Cancel rehearsal" }),
    ).toBeVisible();
    // Nothing on the path offers a link to finish the sign-in somewhere else.
    expect(screen.queryByRole("link")).toBeNull();
    expect(region()).not.toHaveTextContent(/\blink\b/i);

    // The page it stopped on is a frame of the recording too.
    await userEvent.click(
      await handover.findByRole("button", {
        name: "Screenshot of the page the sign-in stopped on",
      }),
    );
    const video = within(region()).getByLabelText(
      "Recording of the reviewer sign-in",
    ) as HTMLVideoElement;
    fireEvent(video, new Event("loadedmetadata"));
    expect(video.currentTime).toBe(11.2);
  });

  it("a refused password: the sign-in failed with the page's words, and later stages were not tested", async () => {
    renderPath(REFUSED);
    const signIn = await rowNamed("Fresh sign-in");
    expect(signIn.getByText("Failed")).toBeVisible();
    expect(signIn.getByText(REFUSED_DETAIL)).toBeVisible();
    // Said once: the attempt ended in the same words as its last stage.
    expect(screen.getAllByText(REFUSED_DETAIL)).toHaveLength(1);
    const connection = await rowNamed("Reviewer connection");
    expect(connection.getByText("Not tested")).toBeVisible();
    expect(
      connection.getByText("The last rehearsal stopped before this stage."),
    ).toBeVisible();
  });

  it("the wrong tenant: the identity row says so, with what to do", async () => {
    renderPath(PASSED, WRONG_TENANT);
    const identity = await rowNamed("Identity and tenant");
    expect(identity.getByText("Wrong tenant")).toBeVisible();
    expect(
      identity.getByText(
        "The reviewer account answers for organization Other Org, not Review Org. Leave the reviewer account in that one organization or project, then run again.",
      ),
    ).toBeVisible();
  });

  it("offers a frame only from the recording it points into", async () => {
    const elsewhere = {
      ...SIGNED_IN,
      evidence: {
        recordingArtifactId: RESERVATION,
        screenshotArtifactId: "res_other#t=9.4",
      },
    };
    renderPath(attemptIn("passed", { stages: [OPENED, elsewhere, CONNECTED] }));
    expect(
      await screen.findByRole("button", { name: "Screenshot of Sign-in page" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Screenshot of Fresh sign-in" }),
    ).toBeNull();
  });

  it("offers no frames until the recording is kept, and says why", async () => {
    world.views = [{ reservationId: RESERVATION, recording: null }];
    const running = attemptIn("running", { stages: [OPENED, SIGNED_IN] });
    const { unmount } = renderPath(running);
    expect(
      await within(region()).findByText(
        "MCPJam keeps the recording once the sign-in ends.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Screenshot/ })).toBeNull();
    unmount();

    renderPath(PASSED);
    expect(
      await within(region()).findByText(
        "No recording was kept for this rehearsal, so its stages have no screenshots.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Screenshot/ })).toBeNull();
  });

  it("a recording that will not play says what to do", async () => {
    renderPath(PASSED);
    await userEvent.click(
      await within(region()).findByRole("button", { name: "Recording 0:48" }),
    );
    fireEvent.error(
      within(region()).getByLabelText("Recording of the reviewer sign-in"),
    );
    expect(
      within(region()).getByText(
        "The recording did not load. Reload the page to try again.",
      ),
    ).toBeVisible();
  });

  it("keeps the stages when the recording cannot be read", async () => {
    world.views = new Error(
      "[CONVEX Q(directoryReadinessBrowserSessions:listForRun)] Could not find public function",
    );
    renderPath(PASSED, VERIFIED);
    expect(
      (await rowNamed("Fresh sign-in")).getByText(SIGNED_IN.detail ?? ""),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Screenshot/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Recording/ })).toBeNull();
  });
});
