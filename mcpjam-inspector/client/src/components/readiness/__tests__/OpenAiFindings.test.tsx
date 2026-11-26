/**
 * The ChatGPT portal's Findings panel: the portal's own issues, MCPJam's
 * open results marked "MCPJam", one row per coded portal rule, the "All" and
 * "Blocking" filter, what an empty panel says, and "Copy findings".
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { placeDirectoryResults, type DirectoryFieldIssue } from "@mcpjam/sdk/browser";
import { OpenAiFindings } from "../OpenAiFindings";
import { answersOf, finding, flow, IMPORTED } from "./openai-fixtures";

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/clipboard", () => clipboard);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast }));

const TEXT = {
  title: "Findings",
  all: "All",
  blocking: "Blocking",
  copy: "Copy findings",
};

const ISSUE: DirectoryFieldIssue = {
  key: "reviewer.loginUrl",
  step: "reviewer",
  code: "required",
  message: "Login URL is required.",
};

/** A package result carrying two of the portal's coded rules, and a model's flag. */
const FINDINGS = [
  finding("openai.package.manifest", "violated", {
    lane: "plugin-package",
    details: {
      portalIssues: [
        {
          message: "Developer name is required.",
          severity: "blocking",
          subject: ".codex-plugin/plugin.json",
        },
        { message: "The plugin version did not change.", severity: "advisory" },
      ],
    },
  }),
  finding("openai.experience.skill-overlap", "informational", {
    provenance: "llm",
    class: "heuristic",
    remediation: "Two skills describe the same task.",
  }),
  finding("openai.submission.urls", "satisfied"),
];

function renderPanel({
  issues = [ISSUE],
  findings = FINDINGS,
  hasRun = true,
}: {
  issues?: DirectoryFieldIssue[];
  findings?: typeof FINDINGS;
  hasRun?: boolean;
} = {}) {
  const steps = placeDirectoryResults({
    flow,
    answers: answersOf(IMPORTED),
    findings,
  }).filter((step) => step.step !== "mcp");
  render(
    <OpenAiFindings
      text={TEXT}
      tab="Metadata & Skills"
      issues={issues}
      steps={steps}
      hasRun={hasRun}
    />,
  );
  return within(screen.getByRole("complementary", { name: "Findings" }));
}

describe("OpenAiFindings", () => {
  beforeEach(() => {
    clipboard.copyToClipboard.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it("lists the portal's issue, each coded rule, and the model's flag, marked MCPJam", () => {
    const panel = renderPanel();
    const rows = panel.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Login URL is required.Blocking",
      "Developer name is required..codex-plugin/plugin.jsonBlockingMCPJam",
      "The plugin version did not change.Non-blockingMCPJam",
      "Two skills describe the same task.Non-blockingMCPJamRead by a model",
    ]);
    // A satisfied check is not a finding.
    expect(panel.queryByText(/openai\.submission\.urls/)).toBeNull();
  });

  it("opens an MCPJam row on the result behind it", async () => {
    const panel = renderPanel();
    await userEvent.click(
      panel.getByRole("button", { name: /Two skills describe the same task/ }),
    );
    expect(
      panel.getByText("Title of openai.experience.skill-overlap"),
    ).toBeVisible();
    expect(panel.getByText("Read by a model, not verified")).toBeVisible();
  });

  it("filters to what blocks submission", async () => {
    const panel = renderPanel();
    await userEvent.click(panel.getByRole("radio", { name: "Blocking" }));
    expect(panel.getAllByRole("listitem")).toHaveLength(2);
    expect(panel.queryByText("The plugin version did not change.")).toBeNull();
  });

  it("copies the shown rows with where each came from", async () => {
    clipboard.copyToClipboard.mockResolvedValue(true);
    const panel = renderPanel();
    await userEvent.click(panel.getByRole("radio", { name: "Blocking" }));
    await userEvent.click(panel.getByRole("button", { name: "Copy findings" }));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(
      [
        "Metadata & Skills findings from an MCPJam rehearsal of the ChatGPT portal",
        "- Blocking: Login URL is required.",
        "- Blocking, found by MCPJam: Developer name is required. (.codex-plugin/plugin.json)",
      ].join("\n"),
    );
    expect(toast.success).toHaveBeenCalledWith("Findings copied.");
  });

  it("says so when the copy fails", async () => {
    clipboard.copyToClipboard.mockResolvedValue(false);
    const panel = renderPanel();
    await userEvent.click(panel.getByRole("button", { name: "Copy findings" }));
    expect(toast.error).toHaveBeenCalledWith(
      "The findings were not copied. Select them in the list and copy them.",
    );
  });

  it("says how much was evaluated when nothing is open", () => {
    const panel = renderPanel({
      issues: [],
      findings: [
        finding("openai.submission.urls", "satisfied"),
        finding("openai.policy.originality", "not-evaluated", {
          notEvaluatedReason: "needs a model",
        }),
      ],
    });
    expect(
      panel.getByText("No findings in 1 evaluated check; 1 still need evidence."),
    ).toBeVisible();
    expect(panel.getByRole("button", { name: "Copy findings" })).toBeDisabled();
  });

  it("asks for a run before there are results", () => {
    const panel = renderPanel({ issues: [], findings: [], hasRun: false });
    expect(
      panel.getByText("No findings yet. Run checks to grade this version."),
    ).toBeVisible();
  });
});
