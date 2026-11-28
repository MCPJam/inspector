/**
 * The export pack: every answer with where it came from, findings without
 * their raw observations, what the directory said, and not one secret, in
 * either format.
 */

import { describe, expect, it } from "vitest";

import { CHATGPT_PLUGIN_FLOW } from "../../src/directory-readiness/flows/index.js";
import {
  buildDirectoryExport,
  type DirectoryHandoffInput,
} from "../../src/directory-readiness/handoff.js";
import { renderDirectoryExportMarkdown } from "../../src/directory-readiness/handoff-markdown.js";
import { completeAnswers } from "../support/claude-connector-answers.js";
import {
  event,
  finding,
  handoffInput,
  snapshot,
} from "../support/directory-handoff.js";

/** The value behind the project secret REVIEWER_PASSWORD, and a token: neither may leave. */
const SECRETS = ["sample-reviewer-password-7f3c", "eyJhbGciOiJIUzI1NiJ9.c2FtcGxlLXRva2Vu.c2lnbmF0dXJl"];
const [PASSWORD, TOKEN] = SECRETS as [string, string];

/** `value` with fields the builders were never told about. */
function withExtra<T extends object>(value: T, extra: Record<string, unknown>): T {
  return Object.assign({}, value, extra);
}

/** Every string in a JSON value, keys included. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...strings(entry)]);
  }
  return [];
}

/** A ChatGPT submission whose inputs carry seeded secrets everywhere a careless builder would copy them from. */
function seededInput(): DirectoryHandoffInput {
  const input = handoffInput({
    flow: CHATGPT_PLUGIN_FLOW,
    answers: [
      withExtra(
        { key: "reviewer.passwordSecret", value: "REVIEWER_PASSWORD", origin: "set" as const, setBy: "user-1", setVia: "api" as const },
        { secretValue: PASSWORD }
      ),
      { key: "reviewer.username", value: "review@example.com", origin: "set", setByLabel: "claude-code 2.1", setVia: "agent" },
    ],
    findings: [
      finding("openai.package.manifest", {
        lane: "plugin-package",
        status: "violated",
        details: { password: PASSWORD, authorization: `Bearer ${TOKEN}` },
      }),
    ],
    events: [
      withExtra(event("credential", { state: "saved" }), { value: PASSWORD }),
      event("status", {
        state: "submitted",
        reference: "REF-1042",
        evidence: withExtra({ kind: "text" as const, value: "Server submitted for review" }, { token: TOKEN }),
      }),
      event("directory-finding", {
        createdAt: 2_000,
        finding: withExtra(
          { directory: "openai" as const, text: "Reviewers could not sign in.\nUse a demo account.", via: "email" as const },
          { raw: PASSWORD }
        ),
      }),
    ],
    snapshots: { production: withExtra(snapshot("production", 3), { token: TOKEN }) },
    latestRun: withExtra({ id: "run-1", status: "completed", resumable: false }, { lease: TOKEN }),
  });
  return {
    ...input,
    submission: withExtra(
      { ...input.submission, directoryRefs: withExtra({ managementUrl: "https://platform.openai.com/plugins/1" }, { password: PASSWORD }) },
      { reviewerPassword: PASSWORD }
    ),
  };
}

describe("buildDirectoryExport", () => {
  it("lists every answer in form order with its origin and who set it, and a secret by its name", () => {
    const pack = buildDirectoryExport(handoffInput({ answers: completeAnswers() }));
    const keys = pack.answers.map((entry) => entry.key);
    expect(keys[0]).toBe("connection.serverUrl");
    expect(keys).toEqual(handoffInput().flow.steps.flatMap((step) => step.fields.map((field) => field.key)));
    expect(pack.answers.find((entry) => entry.key === "company.contactEmail")).toMatchObject({
      origin: "account",
      value: "review@example.com",
    });
    expect(pack.answers.find((entry) => entry.key === "useCases.access")).toMatchObject({
      origin: "default",
      value: "read-only",
    });
    expect(pack.answers.find((entry) => entry.key === "listing.iconUrl")).toEqual({
      step: "listing",
      key: "listing.iconUrl",
      label: "Icon",
      value: null,
      origin: null,
    });

    const seeded = buildDirectoryExport(seededInput());
    expect(seeded.answers.find((entry) => entry.key === "reviewer.passwordSecret")).toEqual({
      step: "reviewer",
      key: "reviewer.passwordSecret",
      label: "Password",
      value: "REVIEWER_PASSWORD",
      origin: "set",
      secret: true,
      setBy: "user-1",
      setVia: "api",
    });
    expect(seeded.directoryFindings).toEqual([
      expect.objectContaining({ text: "Reviewers could not sign in.\nUse a demo account.", via: "email", directory: "openai" }),
    ]);
    expect(seeded.statusHistory).toEqual([expect.objectContaining({ state: "submitted", reference: "REF-1042" })]);
    expect(seeded.findings).toEqual([
      expect.objectContaining({ checkId: "openai.package.manifest", step: "upload", status: "violated" }),
    ]);
  });

  it("holds no secret anywhere, in JSON or in Markdown", () => {
    const pack = buildDirectoryExport(seededInput());
    const json = JSON.stringify(pack, null, 2);
    const markdown = renderDirectoryExportMarkdown(pack);
    for (const text of [...strings(JSON.parse(json)), markdown]) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    // Named, never valued.
    expect(json).toContain("REVIEWER_PASSWORD");
    expect(markdown).toContain("`REVIEWER_PASSWORD`");
  });

  it("renders the same data as Markdown, the same bytes for the same record", () => {
    const pack = buildDirectoryExport(seededInput());
    const markdown = renderDirectoryExportMarkdown(pack);
    // From the JSON alone: what a reader of the JSON file holds renders the same.
    expect(renderDirectoryExportMarkdown(JSON.parse(JSON.stringify(pack)))).toBe(markdown);
    expect(renderDirectoryExportMarkdown(buildDirectoryExport(seededInput()))).toBe(markdown);
    for (const line of [
      "## Remaining portal actions",
      "- Publish plugin (Publish your approved plugin)",
      "## Still unknown",
      "- Password (`reviewer.passwordSecret`): the project secret `REVIEWER_PASSWORD` (set, set by user-1 via api)",
      "- Username (`reviewer.username`): review@example.com (set, set by claude-code 2.1 via agent)",
      "  > Reviewers could not sign in.",
      "  > Use a demo account.",
      "Manage the submission at https://platform.openai.com/plugins/1",
    ]) {
      expect(markdown).toContain(line);
    }
    for (const entry of pack.unknowns) expect(markdown).toContain(entry.detail);
    for (const entry of pack.findings) expect(markdown).toContain(`\`${entry.checkId}\``);
  });
});
