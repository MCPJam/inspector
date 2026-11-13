/**
 * The ChatGPT portal's "MCPs" tab: the connect panel (the URL MCPJam grades,
 * the authentication mcp.json declares, the key, the domain verification
 * state and the token field with its checks under it), then each tool the
 * run read, with and without the results that name it.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  placeDirectoryResults,
  type DirectoryAnswerValue,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { OpenAiMcp, toolsOf } from "../OpenAiMcp";
import { answersOf, finding, flow, VERSION } from "./openai-fixtures";

function mcpStep() {
  const step = flow.steps.find((entry) => entry.id === "mcp");
  if (!step) throw new Error("The ChatGPT flow has no MCPs step");
  return step;
}
const SERVER = {
  ...VERSION.servers[0],
  headerRequirements: [{ name: "X-Api-Key", secret: true }],
};
const SERVER_URL = "https://mcp.example.com/mcp";

const RUN = [
  finding("openai.domain.challenge-served", "satisfied"),
  finding("openai.domain.challenge-matches", "satisfied"),
  finding("openai.endpoint.https", "satisfied", { title: "The server URL uses https" }),
  finding("openai.tools.security-schemes", "informational", {
    details: { tools: 2, inheritsServerDefault: ["list_items", "delete_item"] },
  }),
  finding("openai.tools.annotations", "violated", {
    title: "Every tool declares its hints",
    remediation: "Declare destructiveHint on delete_item.",
    details: { missing: [{ name: "delete_item", missing: ["destructiveHint"] }] },
  }),
];

function placed(
  findings: PlacedFinding["finding"][],
  values: Record<string, DirectoryAnswerValue> = {},
) {
  return placeDirectoryResults({ flow, answers: answersOf(values), findings })
    .filter((entry) => entry.step === "mcp")
    .flatMap((entry) => entry.findings);
}

function renderTab({
  findings = [] as PlacedFinding["finding"][],
  values = {} as Record<string, DirectoryAnswerValue>,
  checkedAt = undefined as number | undefined,
} = {}) {
  const handlers = { onRescan: vi.fn(), onAnswer: vi.fn() };
  render(
    <OpenAiMcp
      step={mcpStep()}
      values={values}
      findings={placed(findings, values)}
      server={SERVER}
      serverUrl={SERVER_URL}
      checkedAt={checkedAt}
      canRescan
      {...handlers}
    />,
  );
  return handlers;
}

describe("OpenAiMcp", () => {
  it("before a run: the saved server, sign-in from mcp.json, and nothing verified", async () => {
    const { onRescan } = renderTab();
    expect(screen.getByRole("heading", { name: "Connect MCP server" })).toBeVisible();
    expect(screen.getByText(SERVER_URL)).toBeVisible();
    expect(screen.getByText("Not connected")).toBeVisible();
    expect(
      screen.getByText("mcp.json: sign-in on first use, headers X-Api-Key"),
    ).toBeVisible();
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(
      screen.getByText("Run checks to read this server's tools and their annotations."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(onRescan).toHaveBeenCalled();
  });

  it("after a run: authorized, the domain verified, each tool with what names it", async () => {
    renderTab({ findings: RUN, checkedAt: Date.now() - 4 * 60_000 });
    expect(screen.getByText("Authorized")).toBeVisible();
    expect(screen.getByText("Domain verified")).toBeVisible();

    const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });
    expect(within(row("list_items")).getByText("No issues found")).toBeVisible();
    expect(within(row("list_items")).getByText("4 minutes ago")).toBeVisible();
    const issues = within(row("delete_item")).getByRole("button", {
      name: "delete_item: 1 issue found",
    });
    expect(screen.queryByText("Declare destructiveHint on delete_item.")).toBeNull();
    await userEvent.click(issues);
    expect(issues).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Declare destructiveHint on delete_item.")).toBeVisible();
  });

  it("keeps the portal's token as an answer, with the domain checks under it", async () => {
    const { onAnswer } = renderTab({
      findings: [
        finding("openai.domain.challenge-served", "not-evaluated", {
          title: "The domain serves the portal's challenge",
          notEvaluatedReason: "Host the token at /.well-known/openai-apps-challenge.",
        }),
      ],
    });
    // A challenge the run could not check verifies nothing.
    expect(screen.getByText("Not verified")).toBeVisible();
    const field = screen.getByLabelText("Domain verification token");
    const block = field.closest("div.space-y-2");
    if (!(block instanceof HTMLElement)) throw new Error("No token field");
    expect(
      within(block).getByText("The domain serves the portal's challenge"),
    ).toBeVisible();
    await userEvent.type(field, "t");
    expect(onAnswer).toHaveBeenCalledWith("mcp.verificationToken", "t");
  });

  it("says when mcp.json names another URL than the saved server", () => {
    renderTab({ values: { "mcp.serverUrl": "https://other.example.com/mcp" } });
    expect(
      screen.getByText(
        "Your mcp.json names https://other.example.com/mcp, and MCPJam grades the saved server. Use the same URL in both.",
      ),
    ).toBeVisible();
  });

  it("reads the tool list from the tool results that name them", () => {
    expect(toolsOf(placed(RUN))).toEqual(["delete_item", "list_items"]);
  });
});
