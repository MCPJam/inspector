/**
 * The copy of ChatGPT's "Submit for review" dialog: the developer identity,
 * the six policy attestations in the portal's words, MCPJam's non-blocking
 * findings, and "Mark as submitted", which records a status event once the
 * person has submitted in the real portal. Nothing is sent to ChatGPT.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryAnswerValue, PlacedFinding } from "@mcpjam/sdk/browser";
import type { SubmissionEvent } from "@/lib/apis/directory-submissions-api";
import { OpenAiSubmit } from "../OpenAiSubmit";
import { finding, flow, IMPORTED, session, view } from "./openai-fixtures";

const api = vi.hoisted(() => ({ recordSubmissionEvent: vi.fn() }));
vi.mock("@/lib/apis/directory-submissions-api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast }));

function flowStep(id: string) {
  const found = flow.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`The ChatGPT flow has no ${id} step`);
  return found;
}
const SUBMIT = flowStep("submit");
const ATTESTATIONS = SUBMIT.fields.find((field) => field.key === "submit.attestations");
const EVERY = (ATTESTATIONS?.options ?? []).map((option) => option.value);
const READY = {
  ...IMPORTED,
  "submit.developerIdentity": "Sample Co",
  "submit.attestations": EVERY,
};
const RECORDED: SubmissionEvent = {
  id: "evt_1",
  submissionId: "sub_1",
  projectId: "proj_1",
  kind: "status",
  state: "submitted",
  reportedOrObserved: "observed",
  actor: "user_1",
  createdAt: 1,
};
const onRecorded = vi.fn();

function renderDialog(
  values: Record<string, DirectoryAnswerValue> = IMPORTED,
  findings: PlacedFinding["finding"][] = [],
  recorded: SubmissionEvent | null = null,
) {
  const submission = view({}, { values, findings });
  const current = session(submission);
  render(
    <OpenAiSubmit
      step={SUBMIT}
      view={submission}
      session={current}
      issues={current.issues.filter((issue) => issue.step === "submit")}
      findings={submission.steps.find((entry) => entry.step === "submit")?.findings ?? []}
      recorded={recorded}
      onRecorded={onRecorded}
      open
      onClose={() => {}}
    />,
  );
  return current;
}

const markButton = () => screen.getByRole("button", { name: /^Mark(ed)? as submitted$/ });

describe("OpenAiSubmit", () => {
  beforeEach(() => {
    api.recordSubmissionEvent.mockReset();
    onRecorded.mockReset();
    toast.success.mockReset();
  });

  it("copies the dialog: the six attestations in the portal's words, and says nothing is sent", () => {
    renderDialog();
    const dialog = within(screen.getByRole("dialog", { name: "Submit for review" }));
    const boxes = dialog.getAllByRole("checkbox");
    expect(boxes).toHaveLength(6);
    expect(
      dialog.getByText(
        "I confirm that my plugin does not target children under 13 or share their personal information with OpenAI.",
      ),
    ).toBeVisible();
    expect(dialog.getByRole("textbox", { name: /Developer identity/ })).toBeVisible();
    expect(dialog.getByRole("textbox", { name: "Additional Submission Context" })).toBeVisible();
    expect(
      dialog.getByText(
        "Nothing is sent to ChatGPT from this rehearsal. Submit in the real portal, then mark it as submitted here.",
      ),
    ).toBeVisible();
    // The portal's own Submit stays, and does nothing here.
    expect(dialog.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(dialog.getByRole("link", { name: /Open the real ChatGPT portal/ })).toHaveAttribute(
      "href",
      flow.submissionUrl,
    );
    expect(dialog.getByText("Error: Tick all 6 policy attestations to submit.")).toBeVisible();
    expect(markButton()).toBeDisabled();
  });

  it("saves a ticked attestation as an answer", async () => {
    const current = renderDialog();
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(current.setAnswer).toHaveBeenCalledWith("submit.attestations", [
      "terms-and-guidelines",
    ]);
  });

  it("lists MCPJam's non-blocking findings from every step, and no blocker", () => {
    renderDialog(IMPORTED, [
      finding("openai.policy.originality", "violated", {
        class: "recommended",
        remediation: "Say how the plugin differs from the sample connector.",
      }),
      finding("openai.submission.privacy-disclosure", "violated", {
        remediation: "Say how long you keep data.",
      }),
    ]);
    const dialog = within(screen.getByRole("dialog", { name: "Submit for review" }));
    expect(dialog.getByText("Non-blocking findings")).toBeVisible();
    expect(
      dialog.getByText("Say how the plugin differs from the sample connector."),
    ).toBeVisible();
    expect(dialog.queryByText("Say how long you keep data.")).toBeNull();
  });

  it("marks the submission as submitted once every attestation is ticked: a status, as seen", async () => {
    api.recordSubmissionEvent.mockResolvedValue(RECORDED);
    renderDialog(READY);
    expect(screen.queryByText(/^Error:/)).toBeNull();
    await userEvent.click(markButton());
    expect(api.recordSubmissionEvent).toHaveBeenCalledWith(
      { projectId: "proj_1", submissionId: "sub_1" },
      {
        kind: "status",
        state: "submitted",
        reportedOrObserved: "observed",
        idempotencyKey: expect.stringMatching(/^ui-status-/),
      },
    );
    expect(onRecorded).toHaveBeenCalledWith(RECORDED);
    expect(toast.success).toHaveBeenCalledWith("Marked as submitted.");
  });

  it("says why a mark was not recorded, and retries under the same key", async () => {
    api.recordSubmissionEvent.mockRejectedValueOnce(new Error("Network down"));
    api.recordSubmissionEvent.mockResolvedValueOnce(RECORDED);
    renderDialog(READY);
    await userEvent.click(markButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The status was not recorded. Network down. Try marking it again.",
    );
    expect(onRecorded).not.toHaveBeenCalled();
    await userEvent.click(markButton());
    const [first, second] = api.recordSubmissionEvent.mock.calls;
    expect(second[1].idempotencyKey).toBe(first[1].idempotencyKey);
    expect(onRecorded).toHaveBeenCalledWith(RECORDED);
  });

  it("once recorded, says so and records nothing again", () => {
    renderDialog(READY, [], RECORDED);
    expect(markButton()).toHaveTextContent("Marked as submitted");
    expect(markButton()).toBeDisabled();
  });
});
