/**
 * The connector form's remaining steps graded from a submission's answers:
 * the portal's own lines where it has them, and MCPJam's rules named as
 * MCPJam's. The Authentication answers are also held against what the run
 * saw of the server's sign-in.
 */

import { describe, expect, it } from "vitest";

import { claudeSubmissionEvidenceFromAnswers } from "../../src/claude-readiness/answers.js";
import { runClaudeAnswerStepChecks } from "../../src/claude-readiness/checks/answer-steps.js";
import type { ClaudeAuthEvidence } from "../../src/claude-readiness/checks/auth.js";
import { runClaudeSubmissionChecks } from "../../src/claude-readiness/checks/submission.js";
import type { DirectoryAnswer } from "../../src/directory-readiness/index.js";
import {
  ACKNOWLEDGMENT_VALUES,
  answer,
  completeAnswers,
  confirmed,
  confirmedAnswers,
} from "../support/claude-connector-answers.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };
const SERVER = "https://mcp.example.com/mcp";
const AS_THEY_STAND =
  "This is an MCPJam check; the portal submits answers as they stand.";

function step(id: string, answers: DirectoryAnswer[]) {
  const found = runClaudeAnswerStepChecks(
    claudeSubmissionEvidenceFromAnswers(answers),
    STAMP
  ).filter((finding) => finding.id === id);
  expect(found, id).toHaveLength(1);
  return found[0];
}

function submission(
  id: string,
  answers: DirectoryAnswer[],
  auth?: ClaudeAuthEvidence
) {
  const found = runClaudeSubmissionChecks(
    { answers: claudeSubmissionEvidenceFromAnswers(answers), auth },
    STAMP
  ).filter((finding) => finding.id === id);
  expect(found, id).toHaveLength(1);
  return found[0];
}

describe("use cases", () => {
  const id = "claude.submission.use-cases";

  it("pass one complete row and the prerequisites", () => {
    const finding = step(id, completeAnswers());
    expect(finding.status).toBe("satisfied");
    expect(finding.class).toBe("required");
    expect(finding.details).toEqual({ useCases: 1, maxRows: 3 });
  });

  it("give the portal's lines for no complete row and no prerequisites", () => {
    const finding = step(
      id,
      completeAnswers([
        answer("useCases.pairs", []),
        answer("useCases.prerequisites", ""),
      ])
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      "Fix these answers before you submit. Use cases: Add at least one use case with an example prompt. Prerequisites: This field is required."
    );
  });

  it("name a half-filled row beside a complete one as MCPJam's check", () => {
    const finding = step(
      id,
      completeAnswers([
        answer("useCases.pairs", [
          { useCase: "Track an order", examplePrompt: "Where is order 1042?" },
          { useCase: "Cancel an order", examplePrompt: " " },
          { useCase: "", examplePrompt: "Refund order 1042." },
        ]),
      ])
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      "Use case 2 has no example prompt. Example prompt 3 has no use case. Fill in the other half or clear those rows. This is an MCPJam check; the portal asks for one complete row."
    );
    expect(finding.details).toMatchObject({ useCases: 1 });
  });
});

describe("company", () => {
  const id = "claude.submission.company";

  it("passes the account's prefills and an https website", () => {
    expect(step(id, completeAnswers()).status).toBe("satisfied");
  });

  it("gives the portal's line for each missing answer", () => {
    const finding = step(
      id,
      completeAnswers([
        answer("company.website", "acme"),
        answer("company.contactEmail", ""),
      ])
    );
    expect(finding.remediation).toBe(
      "Fix these answers before you submit. Company website: Enter a full URL, such as https://example.com. Contact email: This field is required."
    );
  });

  it("asks for https as MCPJam's check", () => {
    const finding = step(
      id,
      completeAnswers([answer("company.website", "http://acme.example")])
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      "Company website is not https. Use an https:// address. This is an MCPJam check; the review page uses the company website as the author only when it is https."
    );
  });
});

describe("authentication answers", () => {
  const id = "claude.submission.authentication";

  it("pass the portal's preselection", () => {
    const finding = step(id, completeAnswers());
    expect(finding.status).toBe("satisfied");
    expect(finding.details).toEqual({
      requirement: "always",
      oauthClient: "dcr",
    });
  });

  it("give the portal's line for a cleared requirement", () => {
    expect(
      step(id, completeAnswers([answer("authentication.requirement", null)]))
        .remediation
    ).toBe(
      "Fix this answer before you submit. Authentication requirement: This field is required."
    );
  });
});

describe("authentication against the server's sign-in", () => {
  const id = "claude.submission.declared-auth-mode";
  const challenged: ClaudeAuthEvidence["unauthenticated"] = {
    status: 401,
    wwwAuthenticate: 'Bearer resource_metadata="https://mcp.example.com/prm"',
    representsProtectedOperation: true,
    servedWithoutCredentials: false,
  };
  const served: ClaudeAuthEvidence["unauthenticated"] = {
    status: 200,
    representsProtectedOperation: false,
    servedWithoutCredentials: true,
  };
  const authServer = (document: Record<string, unknown>) => ({
    issuer: "https://auth.example.com",
    reachable: true,
    document,
  });
  const oauth = (document: Record<string, unknown>): ClaudeAuthEvidence => ({
    enteredUrl: SERVER,
    unauthenticated: challenged,
    prm: { discoveredVia: "www-authenticate", document: { resource: SERVER } },
    firstAuthorizationServer: authServer(document),
  });
  const registering = oauth({
    registration_endpoint: "https://auth.example.com/register",
  });

  it("passes answers the server's sign-in agrees with", () => {
    const finding = submission(id, completeAnswers(), registering);
    expect(finding.status).toBe("satisfied");
    expect(finding.details).toMatchObject({
      declared: { requirement: "always", oauthClient: "dcr" },
      observed: { status: 401, registrationEndpoint: true },
    });
  });

  it("flags None on a server that refuses requests without sign-in", () => {
    const finding = submission(
      id,
      completeAnswers([answer("authentication.requirement", "none")]),
      registering
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      "Authentication requirement says None, but the server refused a request made without sign-in. Choose Always required or Required when the server asks."
    );
  });

  it("flags Always required on a server with no sign-in to offer", () => {
    const finding = submission(id, completeAnswers(), {
      enteredUrl: SERVER,
      unauthenticated: served,
      prm: { discoveredVia: "not-found", fetchError: "answered 404" },
    });
    expect(finding.remediation).toBe(
      "Authentication requirement says Always required, but the server answered without sign-in and publishes no OAuth metadata, so Claude cannot sign users in. Choose None or Required when the server asks, or publish Protected Resource Metadata."
    );
  });

  it("flags a client type the authorization server does not offer", () => {
    expect(submission(id, completeAnswers(), oauth({})).remediation).toBe(
      "OAuth client says Dynamic Client Registration, but the authorization server's metadata has no registration_endpoint. Choose the client type the server supports, or turn on dynamic registration."
    );
    expect(
      submission(
        id,
        completeAnswers([answer("authentication.oauthClient", "cimd")]),
        registering
      ).remediation
    ).toBe(
      "OAuth client says Client ID Metadata Document, but the authorization server does not set client_id_metadata_document_supported to true. Choose the client type the server supports, or turn that support on."
    );
  });

  it("accepts a preregistered client whatever the server advertises", () => {
    const finding = submission(
      id,
      completeAnswers([answer("authentication.oauthClient", "anthropic-held")]),
      oauth({})
    );
    expect(finding.status).toBe("satisfied");
  });

  it("says what it did not see, and never guesses from an outage", () => {
    const unseen = submission(id, completeAnswers(), { enteredUrl: SERVER });
    expect(unseen.status).toBe("not-evaluated");
    expect(unseen.notEvaluatedReason).toBe(
      "this run did not see the server's answer to a request without sign-in or the authorization server's metadata, so the Authentication answers were not compared with the server"
    );
    const outage = submission(id, completeAnswers(), {
      enteredUrl: SERVER,
      unauthenticated: served,
      prm: { discoveredVia: "not-found", unanswered: true },
    });
    expect(outage.status).toBe("not-evaluated");
  });

  it("names the answer it needs when the client is blank", () => {
    const finding = submission(
      id,
      completeAnswers([answer("authentication.oauthClient", null)]),
      registering
    );
    expect(finding.status).toBe("not-evaluated");
    expect(finding.details).toEqual({
      missingInput: "authentication.oauthClient",
    });
  });
});

describe("data handling", () => {
  const id = "claude.submission.data-handling";

  it("asks for the missing answer in the portal's words and the defaults as MCPJam", () => {
    const finding = step(
      id,
      completeAnswers().filter(
        (entry) => entry.key !== "dataHandling.sponsored"
      )
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      `Fix this answer before you submit. Sponsored content: This field is required. Confirm or change these answers: API ownership (the portal's default, We own the API), Personal health data (the portal's default, No). ${AS_THEY_STAND}`
    );
  });

  it("names an imported answer and one confirmed under old wording", () => {
    const finding = step(
      id,
      confirmedAnswers([
        { key: "dataHandling.apiOwnership", value: "own", origin: "imported" },
        { ...confirmed("dataHandling.healthData", "no"), wordingRevision: "1" },
      ])
    );
    expect(finding.remediation).toBe(
      `Personal health data: The wording changed after this was confirmed. Read it again and confirm it. Confirm or change this answer: API ownership (imported). ${AS_THEY_STAND}`
    );
  });

  it("passes once every answer was set or confirmed", () => {
    expect(step(id, confirmedAnswers()).status).toBe("satisfied");
  });
});

describe("test instructions", () => {
  const id = "claude.submission.test-instructions";

  it("are asked for when users sign in, citing the review criteria", () => {
    const finding = step(id, completeAnswers());
    expect(finding.status).toBe("violated");
    expect(finding.source.page).toBe("review-criteria");
    expect(finding.remediation).toBe(
      "Test setup instructions: add a test account and the steps a reviewer needs to sign in and run every tool. Claude's review criteria require test credentials for a server that needs sign-in, and Authentication requirement says Always required. The portal accepts this field empty."
    );
  });

  it("pass when given, and do not apply without sign-in", () => {
    expect(step(id, confirmedAnswers()).status).toBe("satisfied");
    expect(
      step(id, completeAnswers([answer("authentication.requirement", "none")]))
        .status
    ).toBe("not-applicable");
  });

  it("name the requirement they wait on when it is blank", () => {
    const finding = step(
      id,
      completeAnswers([answer("authentication.requirement", "")])
    );
    expect(finding.status).toBe("not-evaluated");
    expect(finding.details).toEqual({
      missingInput: "authentication.requirement",
    });
  });
});

describe("the acknowledgments", () => {
  const id = "claude.submission.attestations";

  it("name the ones not ticked", () => {
    const finding = submission(
      id,
      completeAnswers([
        answer("compliance.acknowledgments", ACKNOWLEDGMENT_VALUES.slice(1)),
      ])
    );
    expect(finding.details).toMatchObject({
      acknowledged: 6,
      notAcknowledged: [
        "I have read and understand the MCP Directory developer guidelines.",
      ],
    });
  });

  it("must be confirmed, not imported", () => {
    const finding = submission(
      id,
      completeAnswers([
        {
          key: "compliance.acknowledgments",
          value: ACKNOWLEDGMENT_VALUES,
          origin: "imported",
        },
      ])
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      `Confirm or change this answer: Policies acknowledged (imported). ${AS_THEY_STAND}`
    );
  });
});

describe("the review page's author", () => {
  it("is graded from the answers, with the company standing in", () => {
    const listing = (answers: DirectoryAnswer[]) =>
      submission("claude.submission.listing-fields", answers);
    expect(listing(completeAnswers()).status).toBe("satisfied");
    expect(
      listing(completeAnswers([answer("company.name", "")])).remediation
    ).toBe(
      "Fix this answer before you submit. Author: An author is required to submit — add one on the Listing step, or fill in your company name and an https:// website to use those."
    );
    expect(
      listing(
        completeAnswers([
          answer("company.name", ""),
          answer("listing.authorName", "Acme Inc."),
        ])
      ).status
    ).toBe("satisfied");
  });
});

describe("a run with no submission", () => {
  it("leaves every step check unevaluated, naming no input", () => {
    const findings = runClaudeAnswerStepChecks(undefined, STAMP);
    expect(findings.map((finding) => finding.id)).toEqual([
      "claude.submission.use-cases",
      "claude.submission.company",
      "claude.submission.authentication",
      "claude.submission.data-handling",
      "claude.submission.test-instructions",
    ]);
    for (const finding of findings) {
      expect(finding.status).toBe("not-evaluated");
      expect(finding.details).toBeUndefined();
    }
  });
});
