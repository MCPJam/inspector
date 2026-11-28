/**
 * The copy of ChatGPT's "Review information" drawer: the portal's steps from
 * the flow, the reviewer credentials with the password entered through
 * MCPJam's reviewer path, the package's test cases, video and release notes
 * read only with where the package keeps each, and MCPJam's results under
 * the fields they read.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryAnswerValue, PlacedFinding } from "@mcpjam/sdk/browser";
import type { DirectorySubmissionSession } from "@/hooks/use-directory-submission";
import type { ProjectSecretView } from "@/hooks/useProjectSecrets";
import { OpenAiReview } from "../OpenAiReview";
import { finding, flow, IMPORTED, REVIEW_IMPORTED, session, view } from "./openai-fixtures";
import { PASSWORD_SECRET } from "./reviewer-fixtures";

const api = vi.hoisted(() => ({
  getLatestReviewerAttempt: vi.fn(),
  startReviewerAttempt: vi.fn(),
  resumeReviewerAttempt: vi.fn(),
  cancelReviewerAttempt: vi.fn(),
}));
vi.mock("@/lib/apis/reviewer-attempts-api", () => api);
const world = vi.hoisted(() => ({
  rows: [] as ProjectSecretView[],
  create: vi.fn(),
}));
vi.mock("@/hooks/use-is-member-actor", () => ({ useIsMemberActor: () => true }));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({ canManageMembers: true, isLoading: false }),
}));
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => world.rows,
  useCreateProjectSecret: () => world.create,
  useUpdateProjectSecret: () => vi.fn(),
}));

function flowStep(id: string) {
  const found = flow.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`The ChatGPT flow has no ${id} step`);
  return found;
}
const REVIEWER = flowStep("reviewer");
const onClose = vi.fn();

function renderDrawer(
  values: Record<string, DirectoryAnswerValue> = IMPORTED,
  findings: PlacedFinding["finding"][] = [],
  overrides: Partial<DirectorySubmissionSession> = {},
) {
  const submission = view({}, { values, findings });
  const current = session(submission, overrides);
  render(
    <OpenAiReview
      flow={flow}
      step={REVIEWER}
      view={submission}
      session={current}
      issues={current.issues.filter((issue) => issue.step === "reviewer")}
      findings={submission.steps.find((entry) => entry.step === "reviewer")?.findings ?? []}
      open
      onClose={onClose}
    />,
  );
  return current;
}

const drawer = () => screen.getByRole("dialog", { name: "Review information" });
const stepButton = (name: string | RegExp) =>
  within(screen.getByRole("list", { name: "Review information steps" })).getByRole("button", {
    name,
  });

describe("OpenAiReview", () => {
  beforeEach(() => {
    onClose.mockReset();
    for (const mock of Object.values(api)) mock.mockReset();
    api.getLatestReviewerAttempt.mockResolvedValue(null);
    world.rows = [];
    world.create.mockReset().mockResolvedValue({});
  });

  it("copies the portal's drawer: its steps, the read-only note, Back and Next", async () => {
    renderDrawer();
    const steps = within(screen.getByRole("list", { name: "Review information steps" }));
    // Numbered as the portal numbers them, with MCPJam's mark where one has findings.
    expect(steps.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "1Countries and translations",
      "2Reviewer credentials, has findings",
      "3Test cases",
      "4Negative test cases",
      "5Supporting content",
    ]);
    expect(
      within(drawer()).getByText(
        "Read-only fields are managed by your plugin ZIP. To change read-only information, update your plugin ZIP and upload it again.",
      ),
    ).toBeVisible();
    // What is MCPJam's, apart from the copy.
    expect(
      within(drawer()).getByText("Your answers save to this rehearsal. Nothing is sent to ChatGPT."),
    ).toBeVisible();
    // It opens on the first step with fields: the first one's were never captured.
    expect(screen.getByRole("heading", { name: "2. Reviewer credentials" })).toBeVisible();
    expect(stepButton(/Reviewer credentials/)).toHaveAttribute("aria-current", "step");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "1. Countries and translations" })).toBeVisible();
    expect(screen.getByText("Its fields were not captured.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "2. Reviewer credentials" })).toBeVisible();
    await userEvent.click(stepButton("Supporting content"));
    expect(screen.getByRole("heading", { name: "5. Supporting content" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("reviewer credentials: the portal's fields and errors, the password through the reviewer path", async () => {
    const current = renderDrawer();
    await userEvent.click(stepButton(/Reviewer credentials/));
    expect(
      screen.getByText(
        "Test credentials must work immediately with no additional setup required. Logging in must provide immediate access to a demo account.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Error: Login URL is required.")).toBeVisible();
    expect(screen.getByText("Error: Password is required.")).toBeVisible();
    await userEvent.type(screen.getByRole("textbox", { name: /Login URL/ }), "h");
    expect(current.setAnswer).toHaveBeenCalledWith("reviewer.loginUrl", "h");

    // The password's place holds MCPJam's reviewer path, never a password input of its own.
    const path = within(await screen.findByRole("region", { name: "Reviewer path" }));
    expect(path.getByLabelText("Reviewer password")).toHaveAttribute("type", "password");
    expect(await path.findByRole("status")).toHaveTextContent(
      "Credentials not saved; reviewer sign-in not tested",
    );
    expect(screen.getAllByLabelText(/password/i)).toHaveLength(1);

    // MCPJam's own reviewer check, apart from the portal's fields.
    expect(screen.getByText("Reviewer check")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Identity tool" })).toBeVisible();
  });

  it("saving the credentials names the password's secret in the portal's Password answer", async () => {
    const user = userEvent.setup();
    const current = renderDrawer();
    await user.click(stepButton(/Reviewer credentials/));
    await user.type(await screen.findByLabelText("Reviewer email"), "review@example.com");
    await user.type(screen.getByLabelText("Reviewer password"), "sample-pass-7Q");
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    expect(world.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: PASSWORD_SECRET, value: "sample-pass-7Q" }),
    );
    expect(current.setAnswer).toHaveBeenCalledWith("reviewer.passwordSecret", PASSWORD_SECRET);
    expect(document.body.innerHTML).not.toContain("sample-pass-7Q");
  });

  it("test cases: read only, each with where the package keeps it, and MCPJam's result under them", async () => {
    renderDrawer({ ...IMPORTED, ...REVIEW_IMPORTED }, [
      finding("openai.submission.test-cases", "violated", {
        title: "5 successful and 3 graceful-failure test cases are supplied",
        remediation: "Add three positive cases and two negative ones.",
      }),
    ]);
    await userEvent.click(stepButton(/^Test cases/));
    const page = within(screen.getByRole("region", { name: "Test cases" }));
    expect(page.getByText("Which servers are in my sample workspace?")).toBeVisible();
    expect(page.getAllByText("expected_behavior")).toHaveLength(2);
    expect(page.getByText("plugin.json: test_cases.positive[1]")).toHaveAttribute(
      "title",
      "plugin.json#/extensions/com.openai/review/test_cases/positive/1",
    );
    expect(page.queryByRole("textbox")).toBeNull();
    expect(page.getByText("Add three positive cases and two negative ones.")).toBeVisible();
    expect(page.getByText("MCPJam")).toBeVisible();

    // The portal's count, under the cases it counts.
    expect(page.getByText("Error: Supply at least 5 test cases. There are 2.")).toBeVisible();
    await userEvent.click(stepButton(/^Negative test cases/));
    const negative = within(screen.getByRole("region", { name: "Negative test cases" }));
    expect(negative.getByText("Delete every sample report now.")).toBeVisible();
    expect(negative.getByText("plugin.json: test_cases.negative[0]")).toBeVisible();
  });

  it("says when no test cases are imported from the package", async () => {
    renderDrawer();
    await userEvent.click(stepButton(/^Test cases/));
    expect(
      screen.getByText("No test cases are imported from this version's package."),
    ).toBeVisible();
  });

  it("supporting content: the video and the release notes, read only, with their sources", async () => {
    renderDrawer({ ...IMPORTED, ...REVIEW_IMPORTED }, [
      finding("openai.submission.release-notes", "violated", {
        remediation: "Say what changed in this version.",
      }),
    ]);
    await userEvent.click(stepButton(/Supporting content/));
    const page = within(screen.getByRole("region", { name: "Supporting content" }));
    expect(page.getByText("https://example.com/sample-walkthrough")).toBeVisible();
    expect(page.getByText("plugin.json: demo_recording_url")).toBeVisible();
    const notes = page.getByText("Release notes").parentElement;
    if (!notes) throw new Error("No Release notes row");
    expect(within(notes).getByText("First release of the sample plugin.")).toBeVisible();
    expect(within(notes).getByText("plugin.json: release_notes")).toBeVisible();
    expect(within(notes).getByText("Say what changed in this version.")).toBeVisible();
    expect(page.queryByRole("textbox")).toBeNull();
  });

  it("puts a result that reads no field on the step of the first field its check reads", async () => {
    renderDrawer(IMPORTED, [
      finding("openai.submission.geography", "violated", {
        remediation: "Declare the countries the plugin is offered in.",
      }),
      finding("openai.submission.demo-access", "violated", {
        remediation: "Give reviewers a demo recording.",
      }),
    ]);
    await userEvent.click(stepButton("Countries and translations, has findings"));
    expect(screen.getByText("Declare the countries the plugin is offered in.")).toBeVisible();
    expect(screen.queryByText("Give reviewers a demo recording.")).toBeNull();
    await userEvent.click(stepButton(/Supporting content/));
    expect(screen.getByText("Give reviewers a demo recording.")).toBeVisible();
  });

  it("Save details saves now, and says when the draft was saved", async () => {
    const current = renderDrawer(IMPORTED, [], { savedAt: Date.UTC(2026, 10, 13, 12) });
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(current.saveNow).toHaveBeenCalled();
    expect(within(drawer()).getByText(/^Draft saved at /)).toBeVisible();
  });
});
