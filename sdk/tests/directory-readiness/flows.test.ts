/**
 * The flow definition itself: keys the backend will store forever, rules the
 * portal enforces, and a placement for every check the Claude engine can
 * produce. A data edit that breaks any of these fails here, not on a page.
 */

import { readdirSync, readFileSync } from "node:fs";

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { CLAUDE_OBSERVATION_IDS } from "../../src/claude-readiness/observations.js";
import { CLAUDE_SUBMISSION_LIMITS } from "../../src/claude-readiness/profile.js";
import {
  gradeClaudeReadiness,
  type ClaudeReadinessInput,
} from "../../src/claude-readiness/runner.js";
import { CLAUDE_READINESS_LANES } from "../../src/claude-readiness/types.js";
import {
  CHATGPT_PLUGIN_FLOW,
  CLAUDE_CONNECTOR_FLOW as FLOW,
  DIRECTORY_FLOW_IDS,
  DIRECTORY_FLOWS,
  directoryFieldWordingRevision,
  directoryFlowDefaults,
  directoryFlowField,
  getDirectoryFlow,
  validateDirectoryAnswerInput,
  withDirectoryFlowDefaults,
  type DirectoryFlowField,
} from "../../src/directory-readiness/index.js";
import labels from "../fixtures/directory-flows/claude-connector-portal-labels.json" with { type: "json" };

const FIELDS = FLOW.steps.flatMap((step) => step.fields);
const STEP_IDS = FLOW.steps.map((step) => step.id);
/** The backend's bound on a stored answer key. */
const BACKEND_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)*$/;

describe("the flow registry", () => {
  it("lists the flows that exist and nothing else", () => {
    expect(DIRECTORY_FLOW_IDS).toEqual(["claude-connector", "chatgpt-plugin"]);
    expect(Object.keys(DIRECTORY_FLOWS)).toEqual([...DIRECTORY_FLOW_IDS]);
    expect(getDirectoryFlow("claude-connector")).toBe(FLOW);
    expect(getDirectoryFlow("chatgpt-plugin")).toBe(CHATGPT_PLUGIN_FLOW);
  });

  it("answers undefined for an id from a request it does not know", () => {
    for (const id of ["claude-plugin", "", "constructor", "__proto__"]) {
      expect(getDirectoryFlow(id)).toBeUndefined();
    }
  });

  it("describes the Claude portal's ten steps", () => {
    expect(FLOW.directory).toBe("claude");
    expect(FLOW.title).toBe("Submit an MCP connector");
    expect(FLOW.submissionUrl).toBe("https://claude.ai/directory/manage");
    expect(STEP_IDS).toEqual([
      "connection",
      "tools",
      "listing",
      "useCases",
      "company",
      "authentication",
      "dataHandling",
      "testLaunch",
      "compliance",
      "review",
    ]);
  });
});

describe("field keys", () => {
  it("are unique, step-prefixed and storable by the backend", () => {
    expect(new Set(FIELDS.map((field) => field.key)).size).toBe(FIELDS.length);
    for (const step of FLOW.steps) {
      for (const field of step.fields) {
        expect(field.key.startsWith(`${step.id}.`)).toBe(true);
        expect(field.key).toMatch(BACKEND_KEY);
        expect(field.key.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("include every key the contract names", () => {
    expect(FIELDS.map((field) => field.key)).toEqual([
      "connection.serverUrl",
      "connection.differentUrls",
      "listing.name",
      "listing.slug",
      "listing.oneLiner",
      "listing.description",
      "listing.categories",
      "listing.authorName",
      "listing.authorUrl",
      "listing.iconUrl",
      "listing.documentationUrl",
      "listing.enterpriseAuthDocsUrl",
      "listing.support",
      "listing.privacyPolicyUrl",
      "useCases.pairs",
      "useCases.prerequisites",
      "useCases.access",
      "company.name",
      "company.website",
      "company.contactName",
      "company.contactEmail",
      "company.role",
      "company.anthropicContact",
      "authentication.requirement",
      "authentication.oauthClient",
      "dataHandling.apiOwnership",
      "dataHandling.healthData",
      "dataHandling.sponsored",
      "testLaunch.instructions",
      "testLaunch.selfTested",
      "testLaunch.identityTool",
      "testLaunch.identityArgs",
      "testLaunch.expectedIdentityPath",
      "testLaunch.expectedIdentity",
      "testLaunch.expectedOrganizationPath",
      "testLaunch.expectedOrganization",
      "testLaunch.fixtures",
      "compliance.acknowledgments",
      "compliance.additionalNotes",
    ]);
  });
});

describe("field rules", () => {
  it("give every required field the portal's missing-answer line", () => {
    const required = FIELDS.filter((field) => field.required);
    expect(required.length).toBeGreaterThan(0);
    for (const field of required) {
      expect(field.errors.required, field.key).toBeTruthy();
    }
  });

  it("only default to values the field accepts", () => {
    const defaults = directoryFlowDefaults(FLOW);
    expect(defaults).toEqual([
      { key: "useCases.access", value: "read-only" },
      { key: "authentication.requirement", value: "always" },
      { key: "authentication.oauthClient", value: "dcr" },
      { key: "dataHandling.apiOwnership", value: "own" },
      { key: "dataHandling.healthData", value: "no" },
    ]);
    for (const { key, value } of defaults) {
      expect(validateDirectoryAnswerInput(FLOW, key, value)).toBeUndefined();
    }
  });

  it("never default an account prefill or a field without options", () => {
    for (const field of FIELDS) {
      if (field.prefill) expect(field.default, field.key).toBeUndefined();
      if (field.default !== undefined) expect(field.options).toBeDefined();
    }
    expect(
      FIELDS.filter((field) => field.prefill).map((field) => field.key)
    ).toEqual(["company.name", "company.contactName", "company.contactEmail"]);
  });

  it("give option values unique within each field", () => {
    for (const field of FIELDS.filter((entry) => entry.options)) {
      const values = (field.options ?? []).map((entry) => entry.value);
      expect(new Set(values).size, field.key).toBe(values.length);
    }
  });

  it("mark the statements someone has to stand behind", () => {
    expect(
      FIELDS.filter((field) => field.declaration).map((field) => field.key)
    ).toEqual([
      "useCases.access",
      "dataHandling.apiOwnership",
      "dataHandling.healthData",
      "dataHandling.sponsored",
      "testLaunch.selfTested",
      "compliance.acknowledgments",
    ]);
  });

  it("use the engine's limits", () => {
    const field = (key: string) => directoryFlowField(FLOW, key);
    expect(field("listing.oneLiner")?.maxLength).toBe(200);
    expect(CLAUDE_SUBMISSION_LIMITS.oneLinerMaxLength).toBe(200);
    expect(field("listing.description")?.maxLength).toBe(
      CLAUDE_SUBMISSION_LIMITS.descriptionMaxLength
    );
    expect(field("listing.categories")).toMatchObject({
      minItems: CLAUDE_SUBMISSION_LIMITS.categoriesMin,
      maxItems: CLAUDE_SUBMISSION_LIMITS.categoriesMax,
    });
    expect(field("useCases.pairs")?.pairs?.maxRows).toBe(
      CLAUDE_SUBMISSION_LIMITS.useCasesMax
    );
    // The portal shows all three rows at once, empty or not.
    expect(field("useCases.pairs")?.pairs?.grow).toBeUndefined();
    expect(field("compliance.acknowledgments")).toMatchObject({
      minItems: 7,
      control: "checkbox-group",
    });
    expect(field("compliance.acknowledgments")?.options).toHaveLength(7);
  });

  it("give free entry to each choice field without options, and only those", () => {
    const choices = new Set([
      "select",
      "multi-select",
      "radio",
      "radio-cards",
      "checkbox-group",
    ]);
    for (const field of FIELDS.filter((entry) => choices.has(entry.control))) {
      expect(Boolean(field.freeEntry), field.key).toBe(!field.options?.length);
    }
    expect(
      FIELDS.filter((field) => field.freeEntry).map((field) => field.key)
    ).toEqual(["listing.categories"]);
  });

  it("only lets an author stand in with fields that exist", () => {
    for (const field of FIELDS) {
      for (const { key } of field.satisfiedBy ?? []) {
        expect(directoryFlowField(FLOW, key), key).toBeDefined();
      }
    }
  });
});

describe("layout and the review page", () => {
  it("draws every field of a laid-out step exactly once, on its own step", () => {
    for (const step of FLOW.steps) {
      const blocks = step.layout?.blocks ?? [];
      const drawn = blocks.flatMap((block) => block.fields ?? []);
      if (drawn.length === 0) continue;
      expect([...drawn].sort(), step.id).toEqual(
        step.fields.map((field) => field.key).sort()
      );
    }
  });

  it("lists review rows that resolve, under steps that exist", () => {
    const review = FLOW.steps.find((step) => step.id === "review")?.layout
      ?.review;
    expect(review?.map((section) => section.title)).toEqual([
      "Connection",
      "Connection & authentication",
      "Listing",
      "Use cases",
      "Company",
      "Authentication",
      "Data handling",
      "Test & launch",
      "Compliance",
    ]);
    for (const section of review ?? []) {
      expect(STEP_IDS).toContain(section.edit);
      for (const row of section.rows) {
        const key = typeof row === "string" ? row : row.blank;
        expect(directoryFlowField(FLOW, key), key).toBeDefined();
      }
    }
  });
});

describe("check placements", () => {
  it("resolve to real steps, fields and answer keys", () => {
    const ids = FLOW.placements.map((placement) => placement.checkId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const placement of FLOW.placements) {
      const step = FLOW.steps.find((entry) => entry.id === placement.step);
      expect(step, placement.checkId).toBeDefined();
      if (placement.field) {
        expect(
          step?.fields.some((field) => field.key === placement.field),
          placement.checkId
        ).toBe(true);
      }
      for (const key of placement.reads ?? []) {
        expect(directoryFlowField(FLOW, key), key).toBeDefined();
      }
    }
  });

  it("send every engine lane to a real step", () => {
    for (const lane of CLAUDE_READINESS_LANES) {
      expect(STEP_IDS).toContain(FLOW.laneSteps[lane]);
    }
  });

  it("Every check maps to exactly one step and declares its inputs", () => {
    // The ids are read from the check definitions themselves, so a check
    // that no run happens to reach still has to be placed.
    const ids = engineCheckIds();
    expect(ids.length).toBeGreaterThanOrEqual(65);
    for (const id of ids) {
      const placements = FLOW.placements.filter((p) => p.checkId === id);
      expect(placements, id).toHaveLength(1);
      const [{ reads, needs }] = placements;
      expect(Array.isArray(reads), `${id} reads`).toBe(true);
      expect(Array.isArray(needs), `${id} needs`).toBe(true);
      // A result read off the server goes stale when the server changes.
      if (needs?.includes("server")) {
        expect(reads, id).toContain("connection.serverUrl");
      }
    }
    // And no placement names a check the engine does not have.
    expect(FLOW.placements.map((p) => p.checkId).sort()).toEqual(ids);
  });

  it("place exactly the checks the Claude engine can produce", () => {
    // Both directions: a check nobody placed lands on a fallback step, and a
    // placement naming no real check is a typo that places nothing.
    const produced = new Set([
      ...gradeClaudeReadiness(everyCheckInput()).findings.map((f) => f.id),
      ...CLAUDE_OBSERVATION_IDS,
    ]);
    expect([...produced].sort()).toEqual(engineCheckIds());
  });
});

/**
 * Every finding id the Claude engine defines, read from its source: each
 * typed check definition, each design lint's slug, and the model
 * observations' catalog.
 */
function engineCheckIds(): string[] {
  const root = new URL("../../src/claude-readiness/", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(new URL(name, root), "utf8"));
  const ids = files.flatMap((source) => [
    ...[
      ...source.matchAll(/: ClaudeCheckDefinition = \{\s*id: "([^"]+)"/g),
    ].map((match) => match[1]),
    ...[...source.matchAll(/designLint\(\s*"([^"]+)"/g)].map(
      (match) => `claude.apps.design.${match[1]}`
    ),
  ]);
  return [...new Set([...ids, ...CLAUDE_OBSERVATION_IDS])].sort();
}

describe("defaults and wording revisions", () => {
  it("are derived, and a stored answer always wins", () => {
    const merged = withDirectoryFlowDefaults(FLOW, [
      { key: "useCases.access", value: "read-write", origin: "set" },
    ]);
    expect(merged.filter((answer) => answer.key === "useCases.access")).toEqual(
      [{ key: "useCases.access", value: "read-write", origin: "set" }]
    );
    expect(
      merged.find((answer) => answer.key === "dataHandling.healthData")
    ).toEqual({
      key: "dataHandling.healthData",
      value: "no",
      origin: "default",
    });
  });

  it("stamp the flow's version unless a field carries its own", () => {
    expect(directoryFieldWordingRevision(FLOW, "listing.name")).toBe(
      FLOW.version
    );
    expect(directoryFieldWordingRevision(FLOW, "listing.tagline")).toBe(
      undefined
    );
    const reworded = withField("compliance.acknowledgments", {
      wordingRevision: "acknowledgments-2",
    });
    expect(
      directoryFieldWordingRevision(reworded, "compliance.acknowledgments")
    ).toBe("acknowledgments-2");
  });
});

describe("the captured portal wording", () => {
  // The fixture is a separate transcript a person checks against the
  // captures; this keeps the flow and the transcript from drifting apart.
  it("is a dated transcript that still needs a person's check", () => {
    expect(labels.capturedAt).toBe(FLOW.version);
    expect(labels.checkedAgainstScreenshots).toBe(false);
    expect(labels.title).toBe(FLOW.title);
  });

  it("matches every step title and intro", () => {
    expect(labels.steps).toEqual(
      FLOW.steps.map(({ id, title, intro }) => ({ id, title, intro }))
    );
  });

  it("matches every field's labels, help, options and error lines", () => {
    const transcript: Record<string, TranscribedField> = labels.fields;
    expect(Object.keys(transcript)).toEqual(FIELDS.map((field) => field.key));
    for (const field of FIELDS) {
      const words = transcript[field.key];
      expect(words.label, field.key).toBe(field.label);
      expect(words.reviewLabel, field.key).toBe(field.reviewLabel);
      expect(words.helper, field.key).toBe(field.helper);
      expect(words.errors ?? {}, field.key).toEqual(field.errors);
      expect(words.options, field.key).toEqual(optionWords(field));
      if (field.key !== "testLaunch.instructions") {
        expect(words.placeholder, field.key).toBe(field.placeholder);
      }
    }
  });

  it("matches the review page's own rows", () => {
    const review = FLOW.steps.find((step) => step.id === "review")?.layout;
    const derived = (review?.review ?? []).flatMap((section) =>
      section.rows.flatMap((row) =>
        typeof row === "string" ? [] : [{ label: row.label, error: row.error }]
      )
    );
    expect(labels.reviewRows).toEqual(derived);
    expect(labels.reviewFootnote).toBe(review?.blocks?.[0]?.text?.missing);
  });
});

interface TranscribedField {
  label: string;
  reviewLabel?: string;
  placeholder?: string;
  helper?: string;
  options?: string[][];
  errors?: Partial<Record<string, string>>;
}

function optionWords(field: DirectoryFlowField): string[][] | undefined {
  return field.options?.map((entry) =>
    entry.help === undefined ? [entry.label] : [entry.label, entry.help]
  );
}

function withField(key: string, change: Partial<DirectoryFlowField>) {
  return {
    ...FLOW,
    steps: FLOW.steps.map((step) => ({
      ...step,
      fields: step.fields.map((field) =>
        field.key === key ? { ...field, ...change } : field
      ),
    })),
  };
}

/** A run that reaches every check: a served widget makes the design lints fire. */
function everyCheckInput(): ClaudeReadinessInput {
  const url = "https://mcp.example.com/mcp";
  return {
    enteredUrl: url,
    authMode: "headless",
    capabilities: ["dns"],
    startedAt: "2026-08-19T00:00:00.000Z",
    evaluatedAt: "2026-08-19T00:00:01.000Z",
    durationMs: 1000,
    endpoint: { enteredUrl: url, redirectChain: [{ url, status: 200 }] },
    auth: {
      enteredUrl: url,
      unauthenticated: {
        status: 401,
        wwwAuthenticate:
          'Bearer resource_metadata="https://mcp.example.com/prm"',
        representsProtectedOperation: true,
        servedWithoutCredentials: false,
      },
      prm: {
        discoveredVia: "www-authenticate",
        document: {
          resource: url,
          authorization_servers: ["https://auth.example.com"],
        },
      },
      firstAuthorizationServer: {
        issuer: "https://auth.example.com",
        reachable: true,
        document: {
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
        },
      },
    },
    apps: {
      enteredUrl: url,
      appsSuiteRan: true,
      tools: [
        {
          name: "widget",
          resourceUri: "ui://w",
          hasNestedField: true,
          hasLegacyField: false,
        },
      ],
      resources: [
        {
          uri: "ui://w",
          mimeType: "text/html;profile=mcp-app",
          html: "<html><body><button>x</button></body></html>",
        },
      ],
    },
    tools: [
      {
        name: "list_orders",
        title: "List orders",
        annotations: { title: "List orders", readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
      } as Tool,
    ],
  };
}
