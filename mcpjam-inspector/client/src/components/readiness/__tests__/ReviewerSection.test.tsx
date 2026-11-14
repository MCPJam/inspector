/**
 * The reviewer path on Test & launch, in each state a person meets: no
 * credentials, credentials saved, rehearsing, signed in and tested, waiting
 * for a person, and ended. Only the API and the Convex hooks are faked; the
 * section's own hooks run as they do on the page.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  type DirectoryFlowField,
  type DirectoryFlowStep,
} from "@mcpjam/sdk/browser";
import type { ProjectSecretView } from "@/hooks/useProjectSecrets";
import { ReviewerPath, ReviewerSection } from "../ReviewerSection";
import {
  ASKED,
  attemptIn,
  EMAIL_SECRET,
  NOV_13,
  PASSWORD_SECRET,
  SCOPE,
  secretRow,
  WAITING,
} from "./reviewer-fixtures";

const api = vi.hoisted(() => ({
  getLatestReviewerAttempt: vi.fn(),
  startReviewerAttempt: vi.fn(),
  resumeReviewerAttempt: vi.fn(),
  cancelReviewerAttempt: vi.fn(),
}));
vi.mock("@/lib/apis/reviewer-attempts-api", () => api);

const world = vi.hoisted(() => ({
  member: true as boolean | undefined,
  admin: true,
  rows: [] as ProjectSecretView[] | undefined,
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => world.member,
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({
    canManageMembers: world.admin,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => world.rows,
  useCreateProjectSecret: () => world.create,
  useUpdateProjectSecret: () => world.update,
}));

// The run's recording is the stage tests' concern; here it is never kept.
// One array, as Convex keeps one result until the data changes.
const noRecordings = vi.hoisted(() => []);
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: () => noRecordings,
}));
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/clipboard", () => clipboard);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast }));

function claudeStep(id: string): DirectoryFlowStep {
  const step = CLAUDE_CONNECTOR_FLOW.steps.find((entry) => entry.id === id);
  if (!step) throw new Error(`The Claude flow has no step ${id}`);
  return step;
}
const TEST_LAUNCH = claudeStep("testLaunch");
const SAVED = [secretRow(EMAIL_SECRET), secretRow(PASSWORD_SECRET)];
const PASSWORD = "sample-reviewer-pass-7Q";
// No flow's placeholder carries this sample, so finding it in React's state
// means the typed value was kept.
const EMAIL = "sample-reviewer-7Q@example.com";

function renderSection(
  step: DirectoryFlowStep = TEST_LAUNCH,
  onAnswer = vi.fn(),
) {
  return render(
    <ReviewerSection {...SCOPE} step={step} values={{}} onAnswer={onAnswer} />,
  );
}

const region = () => screen.getByRole("region", { name: "Reviewer path" });
const status = (text: string) =>
  waitFor(() =>
    expect(within(region()).getByRole("status")).toHaveTextContent(text),
  );

/** Everything React holds for the rendered tree: hook state and props. */
function heldByReact(container: HTMLElement): string {
  const root = Object.entries(container).find(([key]) =>
    key.startsWith("__reactContainer$"),
  )?.[1] as { stateNode: { current: Fiber } } | undefined;
  if (!root) throw new Error("No React root on this container");
  const values: unknown[] = [];
  const visit = (fiber: Fiber | null) => {
    for (let node = fiber; node; node = node.sibling) {
      values.push(node.memoizedProps, node.memoizedState);
      visit(node.child);
    }
  };
  visit(root.stateNode.current);
  const seen = new WeakSet<object>();
  return JSON.stringify(values, (key, value: unknown) => {
    // Links back into the fiber tree, its other copy, and the DOM are walked
    // on their own or are not React's state.
    if (
      key.startsWith("_") ||
      ["return", "alternate", "stateNode"].includes(key)
    ) {
      return undefined;
    }
    if (typeof value === "function" || value instanceof Node) return undefined;
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  });
}
interface Fiber {
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
}

describe("ReviewerSection", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.getLatestReviewerAttempt.mockResolvedValue(null);
    Object.assign(world, { member: true, admin: true, rows: [] });
    world.create.mockReset().mockResolvedValue({});
    world.update.mockReset().mockResolvedValue({});
    clipboard.copyToClipboard.mockReset().mockResolvedValue(true);
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it("no credentials: asks for them, and offers no rehearsal yet", async () => {
    renderSection();
    await status("Credentials not saved; reviewer sign-in not tested");
    expect(screen.getByLabelText("Reviewer email")).toHaveValue("");
    expect(screen.getByLabelText("Reviewer password")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.getByText(
        "MCPJam saves them as project secrets and doesn't show them again.",
      ),
    ).toBeVisible();
    const [credentialsRow] = within(region()).getAllByRole("listitem");
    expect(within(credentialsRow).getByText("Not tested")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Rehearse reviewer sign-in" }),
    ).toBeNull();
  });

  it("saving writes each value straight to its secret, and nothing keeps or shows it", async () => {
    const user = userEvent.setup();
    const { container } = renderSection();
    await user.type(await screen.findByLabelText("Reviewer email"), EMAIL);
    await user.type(screen.getByLabelText("Reviewer password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Save credentials" }));

    expect(world.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: PASSWORD_SECRET, value: PASSWORD }),
    );
    await status("Credentials saved; reviewer sign-in not tested");
    expect(
      screen.getByText(
        `Saved as project secrets ${EMAIL_SECRET} and ${PASSWORD_SECRET}.`,
      ),
    ).toBeVisible();

    // Not on screen, not in any input, not in any component's state or props.
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    for (const input of document.querySelectorAll("input")) {
      expect(input.value).not.toBe(PASSWORD);
    }
    expect(heldByReact(container)).not.toContain(PASSWORD);
    expect(heldByReact(container)).not.toContain(EMAIL);

    // The rehearsal names the secrets; it never carries a value.
    api.startReviewerAttempt.mockResolvedValue(attemptIn("running"));
    await user.click(
      screen.getByRole("button", { name: "Rehearse reviewer sign-in" }),
    );
    expect(api.startReviewerAttempt).toHaveBeenCalledWith(
      SCOPE,
      { usernameSecretName: EMAIL_SECRET, passwordSecretName: PASSWORD_SECRET },
      expect.any(String),
    );
    expect(JSON.stringify(api.startReviewerAttempt.mock.calls)).not.toContain(
      PASSWORD,
    );
  });

  it("a refused save keeps the form, says why, and shows no value", async () => {
    const user = userEvent.setup();
    world.create.mockRejectedValue(
      new Error("Secret name must be at most 64 characters."),
    );
    renderSection();
    await user.type(await screen.findByLabelText("Reviewer email"), EMAIL);
    await user.type(screen.getByLabelText("Reviewer password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The credentials were not saved. Secret name must be at most 64 characters. Try saving them again.",
    );
    expect(screen.getByLabelText("Reviewer password")).toBeVisible();
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it("credentials saved: names them, says the sign-in is not tested, and rehearses", async () => {
    world.rows = SAVED;
    renderSection();
    await status("Credentials saved; reviewer sign-in not tested");
    expect(within(region()).getByText("Established")).toBeVisible();
    expect(
      screen.getByText(
        "No screen, API or export returns them, so type the password into the portal yourself.",
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText("Reviewer password")).toBeNull();

    // Replacing opens the form again, and can be left without a change.
    await userEvent.click(
      screen.getByRole("button", { name: "Replace credentials" }),
    );
    expect(screen.getByLabelText("Reviewer password")).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Reviewer password")).toBeNull();
  });

  it("rehearsing: says so, and cancels the attempt by its id", async () => {
    world.rows = SAVED;
    api.getLatestReviewerAttempt.mockResolvedValue(attemptIn("running"));
    api.cancelReviewerAttempt.mockResolvedValue(
      attemptIn("cancelled", {
        detail: "A project member cancelled this attempt.",
        updatedAt: NOV_13 + 5,
      }),
    );
    renderSection();
    await status("Credentials saved; rehearsing the reviewer sign-in");
    expect(screen.getByText(/^Started /)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Rehearse reviewer sign-in" }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Cancel rehearsal" }),
    );
    expect(api.cancelReviewerAttempt).toHaveBeenCalledWith(SCOPE, "att_1");
    await status("Credentials saved; reviewer sign-in not tested");
    expect(
      screen.getByText("A project member cancelled this attempt."),
    ).toBeVisible();
  });

  it("signed in and tested: gives the date, and rehearses again", async () => {
    world.rows = SAVED;
    api.getLatestReviewerAttempt.mockResolvedValue(
      attemptIn("passed", { testedAt: NOV_13 }),
    );
    renderSection();
    await status("Credentials saved; reviewer sign-in tested on Nov 13, 2026");
    expect(
      screen.getByRole("button", { name: "Rehearse reviewer sign-in" }),
    ).toBeEnabled();
  });

  it("waiting for a person: what they must do, Resume, and the id to resume with", async () => {
    world.rows = SAVED;
    api.getLatestReviewerAttempt.mockResolvedValue(WAITING);
    api.resumeReviewerAttempt.mockResolvedValue(
      attemptIn("running", { resumedAt: NOV_13 + 9, updatedAt: NOV_13 + 9 }),
    );
    renderSection();
    await status("Credentials saved; reviewer sign-in waiting for a person");
    // On the stage that stopped it, and again in the handover.
    expect(screen.getAllByText(ASKED)).toHaveLength(2);
    expect(
      screen.getByText(
        /^Turn off the verification step for the reviewer account/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "A teammate or an agent can resume this attempt with its id.",
      ),
    ).toBeVisible();
    expect(screen.getByText("att_1")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Copy resume command" }),
    );
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(
      "mcpjam readiness reviewer resume sub_1 --attempt att_1 --project proj_1",
    );
    expect(toast.success).toHaveBeenCalledWith("Resume command copied.");

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(api.resumeReviewerAttempt).toHaveBeenCalledWith(SCOPE, "att_1");
    await status("Credentials saved; rehearsing the reviewer sign-in");
  });

  it("ended: says how the last rehearsal ended, and rehearses again", async () => {
    world.rows = SAVED;
    api.getLatestReviewerAttempt.mockResolvedValue(
      attemptIn("failed", {
        detail: "The sign-in page refused the reviewer's password.",
      }),
    );
    api.startReviewerAttempt.mockRejectedValue(
      new Error(
        "This submission already has a reviewer attempt in progress. Resume or cancel it before starting another.",
      ),
    );
    renderSection();
    await status("Credentials saved; reviewer sign-in failed");
    expect(
      screen.getByText("The sign-in page refused the reviewer's password."),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Rehearse reviewer sign-in" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The reviewer sign-in rehearsal did not start. This submission already has a reviewer attempt in progress. Resume or cancel it before starting another. Try starting it again.",
    );
  });

  it("an expired attempt reads as not tested, with why", async () => {
    world.rows = SAVED;
    api.getLatestReviewerAttempt.mockResolvedValue(attemptIn("expired"));
    renderSection();
    await status("Credentials saved; reviewer sign-in not tested");
    expect(
      screen.getByText(
        "The last rehearsal expired before it finished. Rehearse again to test the sign-in.",
      ),
    ).toBeVisible();
  });

  it("an agent's attempt names its own secrets, and rehearses with them again", async () => {
    api.getLatestReviewerAttempt.mockResolvedValue(
      attemptIn("cancelled", {
        usernameSecretName: undefined,
        username: "review@example.com",
        passwordSecretName: "MCPJAM_REVIEWER_PASSWORD",
      }),
    );
    api.startReviewerAttempt.mockResolvedValue(attemptIn("running"));
    renderSection();
    await status("Credentials saved; reviewer sign-in not tested");
    expect(
      screen.getByText("Saved as project secret MCPJAM_REVIEWER_PASSWORD."),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Rehearse reviewer sign-in" }),
    );
    expect(api.startReviewerAttempt).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({
        passwordSecretName: "MCPJAM_REVIEWER_PASSWORD",
        username: "review@example.com",
      }),
      expect.any(String),
    );
  });

  it("a member who is not an admin saves personal secrets, and is told", async () => {
    world.admin = false;
    renderSection();
    expect(
      await screen.findByText(
        "MCPJam saves them as your personal secrets and doesn't show them again. Only you can rehearse with them.",
      ),
    ).toBeVisible();
  });

  it("a guest reads the state, and can neither save nor rehearse", async () => {
    world.member = false;
    world.rows = undefined;
    api.getLatestReviewerAttempt.mockResolvedValue(WAITING);
    renderSection();
    await status("Credentials saved; reviewer sign-in waiting for a person");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Replace credentials" }),
    ).toBeNull();
  });

  it("a guest without an attempt is told who saves the credentials", async () => {
    world.member = false;
    world.rows = undefined;
    renderSection();
    await status("Credentials not saved; reviewer sign-in not tested");
    expect(
      screen.getByText("Not saved. A project member can save them here."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Reviewer password")).toBeNull();
  });

  it("asks for answers the flow keeps on this step outside the portal's layout", async () => {
    // A key no layout lists, so only this section can draw it.
    const outside: DirectoryFlowField = {
      key: "testLaunch.sampleAnswer",
      label: "Sample answer",
      control: "text",
      errors: {},
    };
    const onAnswer = vi.fn();
    renderSection(
      { ...TEST_LAUNCH, fields: [...TEST_LAUNCH.fields, outside] },
      onAnswer,
    );
    await userEvent.type(await screen.findByLabelText("Sample answer"), "g");
    expect(onAnswer).toHaveBeenCalledWith("testLaunch.sampleAnswer", "g");
    // The portal's own fields stay where the step draws them.
    expect(within(region()).queryByText("Test setup instructions")).toBeNull();
  });

  it("shows a status that did not load, with what to do", async () => {
    api.getLatestReviewerAttempt.mockRejectedValue(new Error("Network error"));
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The reviewer sign-in status did not load. Network error. Reload the page to try again.",
    );
  });
});

describe("ReviewerPath", () => {
  const view = { id: "sub_1", projectId: "proj_1", steps: [] };
  const session = { values: {}, setAnswer: vi.fn() };

  beforeEach(() => {
    api.getLatestReviewerAttempt.mockReset().mockResolvedValue(null);
    Object.assign(world, { member: true, admin: true, rows: [] });
  });

  it("draws the reviewer path on Test & launch and on no other step", async () => {
    const { rerender } = render(
      <ReviewerPath
        flow={CLAUDE_CONNECTOR_FLOW}
        step={claudeStep("listing")}
        view={view}
        session={session}
      />,
    );
    expect(screen.queryByRole("region", { name: "Reviewer path" })).toBeNull();
    expect(api.getLatestReviewerAttempt).not.toHaveBeenCalled();

    rerender(
      <ReviewerPath
        flow={CLAUDE_CONNECTOR_FLOW}
        step={TEST_LAUNCH}
        view={view}
        session={session}
      />,
    );
    expect(region()).toBeVisible();
    expect(api.getLatestReviewerAttempt).toHaveBeenCalledWith(
      SCOPE,
      expect.any(AbortSignal),
    );
  });
});
