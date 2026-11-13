/**
 * The ChatGPT plugin flow as data: the portal's stages, the fields a package
 * manages, the reviewer's secret, and a placement for every check the OpenAI
 * engine can emit. A data edit that breaks any of these fails here.
 */

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CHATGPT_PLUGIN_FLOW as FLOW,
  directoryFlowField,
  directoryPlacementOf,
} from "../../src/directory-readiness/index.js";
import { OPENAI_OBSERVATION_IDS } from "../../src/openai-readiness/observations.js";
import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import { OPENAI_PORTAL_LISTING_CATEGORIES } from "../../src/openai-readiness/portal-codes/listing.js";
import { isOpenAIPortalCode } from "../../src/openai-readiness/portal-codes/table.js";
import { gradeOpenAIReadiness } from "../../src/openai-readiness/runner.js";
import { OPENAI_READINESS_LANES } from "../../src/openai-readiness/types.js";
import labels from "../fixtures/directory-flows/chatgpt-plugin-portal-labels.json" with { type: "json" };
import { InMemoryOpenAIPackageSource } from "../openai-readiness/package-fixtures.js";
import { healthyServerEvidence } from "../openai-readiness/server-fixtures.js";
import { completeSubmissionProfile } from "../openai-readiness/submission-fixtures.js";
import { samplePackageFiles } from "../plugin-bundle/chatgpt-package-fixtures.js";

const FIELDS = FLOW.steps.flatMap((step) => step.fields);
const STEP_IDS = FLOW.steps.map((step) => step.id);
/** The backend's bound on a stored answer key. */
const BACKEND_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)*$/;
const SERVER = "mcp.serverUrl";
const field = (key: string) => directoryFlowField(FLOW, key);

/** The Submit for review dialog's six lines, from OpenAI's docs screenshot. */
const ATTESTATIONS = [
  "I have reviewed and agree to OpenAI's Terms and Plugin Guidelines. I confirm that my plugin is in compliance with those Terms and Guidelines.",
  "I confirm that my plugin complies with all laws and regulations applicable to the industry it operates in. I understand that I am responsible for that compliance.",
  "I confirm that my plugin does not initiate or execute money transfers, crypto transfers, or investment trades on behalf of users.",
  "I confirm that I have all necessary rights to any third-party content or API endpoints accessed, displayed, or used by my plugin.",
  "I confirm that my plugin is suitable for individuals under 18 and does not include mature or adult content.",
  "I confirm that my plugin does not target children under 13 or share their personal information with OpenAI.",
];

const MANAGED = [
  "listing.displayName",
  "listing.shortDescription",
  "listing.description",
  "listing.developer",
  "listing.name",
  "listing.category",
  "listing.capabilities",
  "listing.website",
  "listing.support",
  "listing.privacyPolicy",
  "listing.terms",
  "listing.starterPrompts",
  "mcp.serverUrl",
  "reviewer.testCases",
  "reviewer.negativeTestCases",
  "reviewer.demoRecordingUrl",
  "reviewer.releaseNotes",
];

describe("the ChatGPT plugin flow", () => {
  it("describes the portal's stages in order", () => {
    expect(FLOW).toMatchObject({
      id: "chatgpt-plugin",
      directory: "openai",
      submissionUrl: "https://platform.openai.com/plugins",
    });
    expect(FLOW.steps.map(({ id, title }) => [id, title])).toEqual([
      ["upload", "Upload your plugin ZIP"],
      ["listing", "Metadata & Skills"],
      ["mcp", "MCPs"],
      ["reviewer", "Review information"],
      ["submit", "Submit for review"],
      ["publish", "Publish your approved plugin"],
    ]);
  });

  it("draws the Review information drawer's steps, credentials first among the fields", () => {
    const blocks =
      FLOW.steps.find((step) => step.id === "reviewer")?.layout?.blocks ?? [];
    expect(blocks.flatMap((block) => block.heading ?? [])).toEqual([
      "Countries and translations",
      "Reviewer credentials",
      "Test cases",
      "Negative test cases",
      "Supporting content",
    ]);
    expect(
      blocks.find((block) => block.heading === "Reviewer credentials")?.fields
    ).toEqual([
      "reviewer.loginUrl",
      "reviewer.tenant",
      "reviewer.username",
      "reviewer.passwordSecret",
      "reviewer.signInSteps",
    ]);
  });

  it("draws every field of a step exactly once, on its own step", () => {
    for (const step of FLOW.steps) {
      const drawn = (step.layout?.blocks ?? []).flatMap(
        (block) => block.fields ?? []
      );
      expect([...drawn].sort(), step.id).toEqual(
        step.fields.map((entry) => entry.key).sort()
      );
    }
  });
});

describe("field keys", () => {
  it("are unique, step-prefixed and storable by the backend", () => {
    expect(new Set(FIELDS.map((entry) => entry.key)).size).toBe(FIELDS.length);
    for (const step of FLOW.steps) {
      for (const entry of step.fields) {
        expect(entry.key.startsWith(`${step.id}.`)).toBe(true);
        expect(entry.key).toMatch(BACKEND_KEY);
        expect(entry.key.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("include the reviewer and submit keys the brief names", () => {
    expect(FIELDS.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([
        "reviewer.loginUrl",
        "reviewer.tenant",
        "reviewer.username",
        "reviewer.passwordSecret",
        "reviewer.signInSteps",
        "submit.developerIdentity",
        "submit.attestations",
      ])
    );
  });
});

describe("fields the package manages", () => {
  it("are the listing, the server and the review materials, each with its path", () => {
    expect(
      FIELDS.filter((entry) => entry.managedBy === "package").map(
        (entry) => entry.key
      )
    ).toEqual(MANAGED);
    for (const entry of FIELDS) {
      const managed = entry.managedBy === "package";
      expect(Boolean(entry.packagePath), entry.key).toBe(managed);
      if (managed) expect(entry.packagePath).toMatch(/^(plugin|mcp)\.json#\//);
    }
  });

  it("point at the manifest's interface, review and publication blocks and at mcp.json", () => {
    const paths = Object.fromEntries(
      FIELDS.map((entry) => [entry.key, entry.packagePath])
    );
    const openai = "plugin.json#/extensions/com.openai";
    expect(paths).toMatchObject({
      "listing.displayName": `${openai}/interface/displayName`,
      "listing.description": `${openai}/interface/longDescription`,
      "listing.developer": `${openai}/interface/developerName`,
      "listing.privacyPolicy": `${openai}/interface/privacyPolicyURL`,
      "listing.starterPrompts": `${openai}/interface/defaultPrompt`,
      "listing.name": "plugin.json#/name",
      "mcp.serverUrl": "mcp.json#/mcpServers/*/url",
      "reviewer.testCases": `${openai}/review/test_cases/positive`,
      "reviewer.negativeTestCases": `${openai}/review/test_cases/negative`,
      "reviewer.demoRecordingUrl": `${openai}/review/demo_recording_url`,
      "reviewer.releaseNotes": `${openai}/publication/release_notes`,
    });
  });

  it("hold the final submission's limits, which the portal's error lines state", () => {
    for (const [key, limit] of [
      ["listing.displayName", 30],
      ["listing.shortDescription", 30],
      ["listing.description", 4000],
      ["listing.developer", 80],
    ] as const) {
      expect(field(key)?.maxLength, key).toBe(limit);
      expect(field(key)?.errors.tooLong, key).toContain(
        limit.toLocaleString("en-US")
      );
    }
    expect(field("listing.name")?.maxLength).toBe(64);
    expect(field("listing.capabilities")?.maxItems).toBe(20);
    expect(field("listing.starterPrompts")?.maxItems).toBe(3);
    expect(field("reviewer.testCases")).toMatchObject({
      control: "rows",
      minItems: 5,
      maxItems: 5,
    });
    expect(field("reviewer.negativeTestCases")).toMatchObject({
      minItems: 3,
      maxItems: 3,
    });
  });

  it("offer the portal's categories", () => {
    expect(field("listing.category")?.options?.map((o) => o.value)).toEqual([
      ...OPENAI_PORTAL_LISTING_CATEGORIES,
    ]);
  });
});

describe("the reviewer and submit fields", () => {
  it("take the password as a project secret's name, the only secret field", () => {
    expect(
      FIELDS.filter((entry) => entry.control === "secret").map((e) => e.key)
    ).toEqual(["reviewer.passwordSecret"]);
    expect(field("reviewer.passwordSecret")?.required).toBe(true);
  });

  it("ask for an https login URL, a username, and sign-in steps once a tenant is named", () => {
    expect(field("reviewer.loginUrl")).toMatchObject({
      required: true,
      format: "https-url",
    });
    expect(field("reviewer.username")?.required).toBe(true);
    expect(field("reviewer.signInSteps")).toMatchObject({
      requiredWith: ["reviewer.tenant"],
    });
    expect(field("reviewer.signInSteps")?.required).toBeUndefined();
  });

  it("require all six attestations, word for word, as a declaration", () => {
    const attestations = field("submit.attestations");
    expect(attestations?.options?.map((o) => o.label)).toEqual(ATTESTATIONS);
    expect(attestations).toMatchObject({
      control: "checkbox-group",
      required: true,
      declaration: true,
      minItems: 6,
    });
    expect(
      FIELDS.filter((entry) => entry.declaration).map((e) => e.key)
    ).toEqual(["submit.attestations"]);
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
          step?.fields.some((entry) => entry.key === placement.field),
          placement.checkId
        ).toBe(true);
      }
      for (const key of placement.reads ?? []) {
        expect(field(key), key).toBeDefined();
      }
    }
  });

  it("send every engine lane to a real step", () => {
    for (const lane of OPENAI_READINESS_LANES) {
      expect(STEP_IDS).toContain(FLOW.laneSteps[lane]);
    }
  });

  it("place every check the OpenAI engine can emit exactly once, with its inputs", async () => {
    const { ids, families } = sourceCheckIds();
    expect(ids.length).toBeGreaterThanOrEqual(86);
    const produced = await producedCheckIds();
    // Every id built at run time comes from a family the source declares.
    for (const id of produced.filter((entry) => !ids.includes(entry))) {
      expect(
        families.some((prefix) => id.startsWith(prefix)),
        id
      ).toBe(true);
    }
    for (const id of new Set([...ids, ...produced])) {
      const placements = matching(id);
      expect(placements, id).toHaveLength(1);
      const [{ reads, needs }] = placements;
      expect(Array.isArray(reads), `${id} reads`).toBe(true);
      expect(Array.isArray(needs), `${id} needs`).toBe(true);
      // A result read off the server goes stale when the server changes.
      if (needs?.includes("server")) expect(reads, id).toContain(SERVER);
    }
    // Both families were exercised, so their ids are placed, not assumed.
    for (const prefix of families) {
      expect(
        produced.some((id) => id.startsWith(prefix)),
        prefix
      ).toBe(true);
    }
    // And no placement names a check the engine does not have.
    for (const { checkId } of FLOW.placements) {
      const known = checkId.endsWith(".*")
        ? families.includes(checkId.slice(0, -1))
        : ids.includes(checkId) || produced.includes(checkId);
      expect(known, checkId).toBe(true);
    }
  });

  it("put a finding named at run time on its family's step", () => {
    expect(
      directoryPlacementOf(FLOW, "openai.package.observation.rawEntryNames")
    ).toMatchObject({ step: "upload", needs: ["package"] });
    expect(directoryPlacementOf(FLOW, "openai.package.archive")?.checkId).toBe(
      "openai.package.archive"
    );
    expect(directoryPlacementOf(FLOW, "openai.unknown.check")).toBeUndefined();
  });

  it("need none for the portal's codes, which travel inside findings", async () => {
    // A name the portal refuses: its code rides on the manifest finding.
    const result = await gradedRun({ name: "com.example.notes" });
    expect(
      result.findings.filter((finding) => isOpenAIPortalCode(finding.id))
    ).toEqual([]);
    const manifest = result.findings.find(
      (finding) => finding.id === "openai.package.manifest"
    );
    expect(manifest?.details?.portalIssues).toEqual([
      expect.objectContaining({ portalCode: "plugin_name_format" }),
    ]);
  });
});

describe("the captured portal wording", () => {
  // A separate transcript a person checks against the captures; this keeps
  // the flow and the transcript from drifting apart.
  it("is a dated transcript that still needs a person's check", () => {
    expect(labels.flowId).toBe(FLOW.id);
    expect(labels.capturedAt).toBe(FLOW.version);
    expect(labels.checkedAgainstScreenshots).toBe(false);
    expect(labels.title).toBe(FLOW.title);
  });

  it("matches every step title and intro, and the drawer's steps", () => {
    expect(labels.steps).toEqual(
      FLOW.steps.map(({ id, title, intro }) => ({ id, title, intro }))
    );
    const drawer = FLOW.steps.find((step) => step.id === "reviewer");
    expect(labels.reviewInformationSteps).toEqual(
      (drawer?.layout?.blocks ?? []).flatMap((block) => block.heading ?? [])
    );
  });

  it("matches every field's labels, help, options and error lines", () => {
    const transcript: Record<string, TranscribedField> = labels.fields;
    expect(Object.keys(transcript)).toEqual(FIELDS.map((entry) => entry.key));
    for (const entry of FIELDS) {
      const words = transcript[entry.key];
      expect(words.label, entry.key).toBe(entry.label);
      expect(words.placeholder, entry.key).toBe(entry.placeholder);
      expect(words.helper, entry.key).toBe(entry.helper);
      expect(words.errors ?? {}, entry.key).toEqual(entry.errors);
      expect(words.options, entry.key).toEqual(
        entry.options?.map((option) => [option.label])
      );
    }
  });
});

interface TranscribedField {
  label: string;
  placeholder?: string;
  helper?: string;
  options?: string[][];
  errors?: Partial<Record<string, string>>;
}

function matching(id: string) {
  return FLOW.placements.filter(
    ({ checkId }) =>
      checkId === id ||
      (checkId.endsWith(".*") && id.startsWith(checkId.slice(0, -1)))
  );
}

/**
 * Every finding id the OpenAI engine defines, read from its source: each
 * literal `id`, and the prefixes of ids it builds at run time.
 */
function sourceCheckIds(): { ids: string[]; families: string[] } {
  const root = new URL("../../src/openai-readiness/", import.meta.url);
  const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(new URL(name, root), "utf8"));
  const found = (pattern: RegExp) =>
    sources.flatMap((source) =>
      [...source.matchAll(pattern)].map((match) => match[1])
    );
  return {
    ids: [
      ...new Set([
        ...found(/\bid: "(openai\.[a-z0-9.-]+)"/g),
        ...OPENAI_OBSERVATION_IDS,
      ]),
    ].sort(),
    families: [...new Set(found(/\bid: `(openai\.[a-z0-9.-]+\.)\$\{/g))].sort(),
  };
}

/**
 * The ids of a run that reaches the run-time families: a profile tool for
 * the profile checks, and a package read with no archive facts, whose gaps
 * become observation findings.
 */
async function producedCheckIds(): Promise<string[]> {
  return (await gradedRun()).findings.map((finding) => finding.id);
}

async function gradedRun(manifest: Record<string, unknown> = {}) {
  const server = healthyServerEvidence();
  return gradeOpenAIReadiness({
    target: "https://plugin.example.com/mcp",
    mode: "mcp-uploaded-skills",
    authMode: "headless",
    capabilities: [],
    startedAt: "2026-11-13T00:00:00.000Z",
    evaluatedAt: "2026-11-13T00:00:01.000Z",
    durationMs: 1000,
    ...server,
    tools: [
      ...(server.tools ?? []),
      {
        name: "get_profile",
        description: "Return the signed-in account's profile",
        inputSchema: { type: "object" },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        _meta: { "openai/profile": true },
      },
    ],
    package: await readOpenAIPluginPackage(
      new InMemoryOpenAIPackageSource(samplePackageFiles(manifest))
    ),
    submissionProfile: completeSubmissionProfile(),
  });
}
