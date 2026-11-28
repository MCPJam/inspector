/**
 * The portal's review page drawn from the flow: its sections, labels and
 * error lines, the counts that include what only the review page asks for,
 * the one-line summaries, and MCPJam's open results under each section.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  placeDirectoryResults,
  validateDirectoryAnswers,
  withDirectoryFlowDefaults,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { PortalReview, portalText } from "../PortalReview";

const flow = CLAUDE_CONNECTOR_FLOW;
const reviewStep = flow.steps[flow.steps.length - 1];

/** What a new draft holds: the portal's defaults and the account's details. */
const DRAFT: Record<string, DirectoryAnswerValue> = {
  "company.name": "Sample Co",
  "company.contactName": "Sample Person",
  "company.contactEmail": "review@example.com",
};

const FILLED: Record<string, DirectoryAnswerValue> = {
  ...DRAFT,
  "connection.serverUrl": "https://mcp.example.com/mcp",
  "listing.name": "Sample",
  "listing.slug": "sample",
  "listing.oneLiner": "Runs sample checks.",
  "listing.description": "Runs sample checks from Claude.",
  "listing.categories": ["Developer tools"],
  "listing.documentationUrl": "https://docs.example.com",
  "listing.support": "help@example.com",
  "listing.privacyPolicyUrl": "https://example.com/privacy",
  "useCases.pairs": [
    { useCase: "Check a server", examplePrompt: "Check my server." },
    { useCase: "Run a suite", examplePrompt: "Run the smoke suite." },
  ],
  "useCases.prerequisites": "A sample account.",
  "useCases.access": "read-write",
  "company.website": "https://example.com",
  "authentication.oauthClient": "cimd",
  "dataHandling.sponsored": "no",
  "testLaunch.instructions": "Sign in with the sample account.",
  "testLaunch.selfTested": true,
  "compliance.acknowledgments": (
    flow.steps.find((step) => step.id === "compliance")?.fields[0]?.options ??
    []
  ).map((option) => option.value),
  "compliance.additionalNotes": "Nothing else.",
};

const answersOf = (values: Record<string, DirectoryAnswerValue>) =>
  Object.entries(values).map(([key, value]): DirectoryAnswer => ({
    key,
    value,
    origin: "set",
  }));

function finding(
  id: string,
  status: "violated" | "informational",
  overrides: Partial<PlacedFinding["finding"]> = {},
): PlacedFinding["finding"] {
  return {
    id,
    title: `Title of ${id}`,
    lane: "submission-artifacts",
    class: "required",
    status,
    remediation: `Fix ${id}.`,
    source: {},
    provenance: "wire",
    intrusiveness: "passive",
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    engineVersion: "test",
    ...overrides,
  };
}

function review(
  values: Record<string, DirectoryAnswerValue>,
  placed = placeDirectoryResults({ flow, answers: [] }),
) {
  const answers = answersOf(values);
  const onEdit = vi.fn();
  render(
    <PortalReview
      flow={flow}
      step={reviewStep}
      values={Object.fromEntries(
        withDirectoryFlowDefaults(flow, answers).map((answer) => [
          answer.key,
          answer.value,
        ]),
      )}
      issues={validateDirectoryAnswers(flow, answers, { on: "review" })}
      placed={placed}
      onEdit={onEdit}
    />,
  );
  return { onEdit };
}

/** One section of the review page, found by its Edit link. */
function section(title: string) {
  const edit = screen.getByRole("button", { name: `Edit ${title}` });
  const element = edit.parentElement?.parentElement;
  if (!element) throw new Error(`No section ${title}`);
  return within(element);
}

describe("PortalReview", () => {
  it("counts an empty draft the review page's way", () => {
    review(DRAFT);
    // The stepper counts 8 on Listing; the review page also asks for an author.
    const listing = section("Listing");
    expect(listing.getByText("9 fields to fix")).toBeVisible();
    expect(listing.getByText("Author")).toBeVisible();
    expect(
      listing.getByText(
        "Error: An author is required to submit — add one on the Listing step, or fill in your company name and an https:// website to use those",
      ),
    ).toBeVisible();
    expect(listing.getByText("Error: Slug is required")).toBeVisible();
    // The server URL, and the tool list the portal captures from it.
    const connection = section("Connection");
    expect(connection.getByText("2 fields to fix")).toBeVisible();
    expect(connection.getByText("Captured tool list")).toBeVisible();
    expect(
      connection.getByText(/^Error: A captured tool list is required/),
    ).toBeVisible();
    // The seven acknowledgments are one field.
    expect(section("Compliance").getByText("1 field to fix")).toBeVisible();
    // The portal's defaults and the account's details count as answers.
    expect(section("Use cases").getByText("2 fields to fix")).toBeVisible();
    expect(section("Use cases").getByText("Read only")).toBeVisible();
    expect(section("Company").getByText("1 field to fix")).toBeVisible();
    expect(section("Company").getByText("Primary contact")).toBeVisible();
    expect(section("Data handling").getByText("1 field to fix")).toBeVisible();
  });

  it("summarises sections with nothing to fix in the portal's words", () => {
    review(DRAFT);
    expect(
      section("Connection & authentication").getByText(
        "Authentication always required · Dynamic Client Registration",
      ),
    ).toBeVisible();
    expect(
      section("Authentication").getByText(
        "OAuth 2.0 + Dynamic Client Registration",
      ),
    ).toBeVisible();
    // Nothing to open in an empty Test & launch: a summary, no rows.
    expect(
      section("Test & launch").getByText("Not tested with MCP Inspector"),
    ).toBeVisible();
    expect(section("Test & launch").queryByRole("term")).toBeNull();
  });

  it("summarises a filled submission and opens a section on request", async () => {
    review(FILLED);
    expect(
      section("Connection").getByText("https://mcp.example.com/mcp"),
    ).toBeVisible();
    expect(
      section("Listing").getByText("Sample · sample · Developer tools"),
    ).toBeVisible();
    expect(
      section("Use cases").getByText(
        "Read and write · Check a server, Run a suite",
      ),
    ).toBeVisible();
    expect(
      section("Company").getByText("Sample Co · Sample Person"),
    ).toBeVisible();
    expect(
      section("Data handling").getByText(
        "We own the API · Health data: No · Sponsored content: No",
      ),
    ).toBeVisible();
    expect(
      section("Test & launch").getByText(
        "Test instructions provided · Tested with MCP Inspector",
      ),
    ).toBeVisible();
    expect(
      section("Compliance").getByText(
        "All 7 policies acknowledged · Additional information provided",
      ),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /^Compliance/ }));
    expect(section("Compliance").getByText("7 of 7")).toBeVisible();
    expect(
      section("Compliance").getByText("Additional information"),
    ).toBeVisible();
  });

  it("lists MCPJam's open results under the section of their step", () => {
    const answers = answersOf(FILLED);
    const placed = placeDirectoryResults({
      flow,
      answers,
      findings: [
        finding("claude.submission.listing-fields", "violated"),
        // No Tools row: tool results sit under Connection.
        finding("claude.tools.title-present", "violated", {
          lane: "directory-policy",
        }),
        finding("claude.experience.tool-overlap", "informational", {
          class: "heuristic",
          provenance: "llm",
          lane: "experience-insights",
        }),
        // The review step's own results follow the page, not a section.
        finding("claude.submission.declarations-confirmed", "violated"),
      ],
    });
    review(FILLED, placed);

    const listing = section("Listing");
    expect(listing.getByText("MCPJam · 1 blocker")).toBeVisible();
    expect(listing.getByText("MCPJam · Blocker")).toBeVisible();
    // No author given: the company name and website stand in, as the portal says.
    expect(listing.getByText("Sample Co · https://example.com")).toBeVisible();
    expect(
      listing.getByText("Title of claude.submission.listing-fields"),
    ).toBeVisible();
    expect(
      listing.getByText("Fix claude.submission.listing-fields."),
    ).toBeVisible();

    const connection = section("Connection");
    expect(connection.getByText("MCPJam · 1 blocker")).toBeVisible();
    expect(connection.getByText("MCPJam · 1 likely flag")).toBeVisible();
    const marks = connection
      .getAllByText(/^MCPJam · (Blocker|Likely flag)$/)
      .map((mark) => mark.textContent);
    expect(marks).toEqual(["MCPJam · Blocker", "MCPJam · Likely flag"]);

    expect(
      screen.queryByText("Title of claude.submission.declarations-confirmed"),
    ).toBeNull();
  });

  it("leaves a result out once an answer it read has changed", () => {
    const placed = placeDirectoryResults({
      flow,
      answers: answersOf(FILLED),
      findings: [finding("claude.submission.listing-fields", "violated")],
      gradedAnswers: answersOf({ ...FILLED, "listing.name": "Old name" }),
    });
    review(FILLED, placed);
    expect(screen.queryByText(/MCPJam · /)).toBeNull();
  });

  it("opens the step a section's Edit link names", async () => {
    const { onEdit } = review(DRAFT);
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Connection & authentication" }),
    );
    expect(onEdit).toHaveBeenCalledWith("authentication");
  });
});

describe("portalText", () => {
  it("copies every answer in the portal's order and words", () => {
    const values = Object.fromEntries(
      withDirectoryFlowDefaults(flow, answersOf(FILLED)).map((answer) => [
        answer.key,
        answer.value,
      ]),
    );
    const text = portalText(flow, values);
    expect(text).toContain("Listing\nName: Sample\nSlug: sample\n");
    expect(text).toContain("Read/write capabilities: Read and write");
    expect(text).toContain(
      "Use cases: Check a server: Check my server.\nRun a suite: Run the smoke suite.",
    );
    expect(text).toContain("Policy acknowledgements: 7 of 7");
    // Blank answers are left out, and so is a step with none.
    expect(text).not.toContain("Role:");
    expect(text).not.toMatch(/^Tools$/m);
  });
});
