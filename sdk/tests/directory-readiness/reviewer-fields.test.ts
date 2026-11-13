/**
 * The reviewer section's answers in both flows: the identity tool and what it
 * should answer, and the fixtures with their lookups, on the step each portal
 * keeps its reviewer section on, and what a run reads from them.
 */

import { describe, expect, it } from "vitest";

import {
  CHATGPT_PLUGIN_FLOW,
  CLAUDE_CONNECTOR_FLOW,
  DIRECTORY_REVIEWER_FIELDS,
  directoryFlowField,
  directoryReviewerSpec,
  directoryReviewerStep,
  validateDirectoryAnswers,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
} from "../../src/directory-readiness/index.js";

const answer = (key: string, value: DirectoryAnswerValue): DirectoryAnswer => ({
  key,
  value,
  origin: "set",
});

describe.each([
  [CLAUDE_CONNECTOR_FLOW, "testLaunch"],
  [CHATGPT_PLUGIN_FLOW, "reviewer"],
])("the $id flow's reviewer section", (flow, step) => {
  const key = (name: string) => `${step}.${name}`;

  it("holds the identity and fixture fields on the reviewer step", () => {
    expect(directoryReviewerStep(flow)).toBe(step);
    for (const name of DIRECTORY_REVIEWER_FIELDS) {
      expect(directoryFlowField(flow, key(name)), name).toMatchObject({
        control: name === "fixtures" ? "pairs" : "text",
      });
      expect(directoryFlowField(flow, key(name))?.required).toBeUndefined();
    }
    expect(directoryFlowField(flow, key("fixtures"))?.pairs?.keys).toEqual([
      "fixture",
      "lookup",
    ]);
  });

  it("asks for a path beside an expected value, and a tool beside either", () => {
    const own = new Set(DIRECTORY_REVIEWER_FIELDS.map(key));
    const issues = validateDirectoryAnswers(flow, [
      answer(key("expectedIdentity"), "review@example.com"),
    ]).filter((issue) => own.has(issue.key));
    expect(issues).toEqual([
      expect.objectContaining({
        key: key("identityTool"),
        message: "Add identity tool for the expected reviewer you entered.",
      }),
      expect.objectContaining({
        key: key("expectedIdentityPath"),
        message: "Add identity path for the expected reviewer you entered.",
      }),
    ]);
  });

  it("reads the identity check and the fixtures from the answers", () => {
    const spec = directoryReviewerSpec(flow, [
      answer(key("identityTool"), "whoami"),
      answer(key("identityArgs"), '{"project": "sample-project"}'),
      answer(key("expectedIdentityPath"), "$.user.email"),
      answer(key("expectedIdentity"), " review@example.com "),
      answer(key("fixtures"), [
        {
          fixture: "Sample Project",
          lookup: 'get_project {"name": "Sample Project"}',
        },
        { fixture: "Sample Server", lookup: "list_servers" },
        { fixture: "Broken", lookup: "get_project {name" },
        { fixture: "Toolless", lookup: "" },
        { fixture: " ", lookup: "list_servers" },
      ]),
    ]);
    expect(spec.identity).toEqual({
      tool: "whoami",
      arguments: { project: "sample-project" },
      identityPath: "$.user.email",
      expectedIdentity: "review@example.com",
      organizationPath: undefined,
      expectedOrganization: undefined,
    });
    expect(spec.fixtures).toEqual([
      {
        name: "Sample Project",
        tool: "get_project",
        arguments: { name: "Sample Project" },
      },
      { name: "Sample Server", tool: "list_servers", arguments: {} },
      {
        name: "Broken",
        tool: "get_project",
        arguments: {},
        problem: "its lookup's arguments are not a JSON object",
      },
      {
        name: "Toolless",
        tool: "",
        arguments: {},
        problem: "its lookup names no tool",
      },
    ]);
  });

  it("says when the identity tool's arguments are not a JSON object, and names no tool when none is set", () => {
    expect(
      directoryReviewerSpec(flow, [
        answer(key("identityTool"), "whoami"),
        answer(key("identityArgs"), "[1, 2]"),
      ]).identity
    ).toBe("the identity tool's arguments are not a JSON object");
    expect(directoryReviewerSpec(flow, []).identity).toBeUndefined();
  });
});

describe("the cases a fixture can block", () => {
  it("are Claude's use cases and test instructions", () => {
    const { cases } = directoryReviewerSpec(CLAUDE_CONNECTOR_FLOW, [
      answer("useCases.pairs", [
        { useCase: "Look up", examplePrompt: "Open Sample Project" },
      ]),
      answer("testLaunch.instructions", "Sign in as the reviewer."),
      answer("listing.description", "Not read by reviewers as a case."),
      answer("testLaunch.fixtures", [
        { fixture: "Sample Project", lookup: "list_projects" },
      ]),
    ]);
    expect(cases).toEqual([
      { label: "Use cases 1", text: "Look up Open Sample Project" },
      { label: "Test setup instructions", text: "Sign in as the reviewer." },
    ]);
  });

  it("are ChatGPT's test cases and sign-in steps", () => {
    const { cases } = directoryReviewerSpec(CHATGPT_PLUGIN_FLOW, [
      answer("reviewer.testCases", [
        { prompt: "List my projects", expected: "Sample Project" },
      ]),
      answer("reviewer.signInSteps", "Choose Sample Org."),
    ]);
    expect(cases).toEqual([
      { label: "Sign-in steps", text: "Choose Sample Org." },
      { label: "Test cases 1", text: "List my projects Sample Project" },
    ]);
  });
});
