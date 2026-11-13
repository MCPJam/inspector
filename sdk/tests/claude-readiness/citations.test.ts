/**
 * Where findings send a reader. Anthropic's connector docs moved from
 * `docs.claude.com/en/docs/mcp/`, whose paths now redirect to a generic page,
 * so a citation there dead-ends; every citation also says when its page was
 * last read. OpenAI's guidelines page moved to `plugin-guidelines`.
 */

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_POLICY_MANIFEST,
  CLAUDE_POLICY_PAGES,
  CLAUDE_POLICY_SNAPSHOT_DATE,
  type ClaudePolicyPage,
} from "../../src/claude-readiness/manifest.js";
import { gradeClaudeReadiness } from "../../src/claude-readiness/runner.js";
import {
  OPENAI_PLUGINS_POLICY_PAGES,
  OPENAI_POLICY_MANIFEST,
} from "../../src/openai-readiness/manifest.js";
import { completeAnswers } from "../support/claude-connector-answers.js";

const DEAD = "docs.claude.com/en/docs/mcp";
const CURRENT = "https://claude.com/docs/";
/** Read at their current URL on the snapshot date. */
const READ: ClaudePolicyPage[] = [
  "directory",
  "verification",
  "submission",
  "review-criteria",
  "authentication",
];

describe("Claude citations", () => {
  it("never point under the dead docs.claude.com prefix", () => {
    for (const page of CLAUDE_POLICY_PAGES) {
      const { url } = CLAUDE_POLICY_MANIFEST[page];
      expect(url, page).not.toContain(DEAD);
      expect(url.startsWith(CURRENT), page).toBe(true);
    }
    const url = "https://mcp.example.com/mcp";
    const { findings } = gradeClaudeReadiness({
      enteredUrl: url,
      authMode: "headless",
      capabilities: [],
      startedAt: "2026-08-19T00:00:00.000Z",
      evaluatedAt: "2026-08-19T00:00:01.000Z",
      durationMs: 1,
      endpoint: { enteredUrl: url, redirectChain: [] },
      auth: { enteredUrl: url },
      apps: { enteredUrl: url, appsSuiteRan: false },
      submissionAnswers: completeAnswers(),
    });
    expect(findings.length).toBeGreaterThan(50);
    for (const finding of findings) {
      expect(finding.source.url, finding.id).not.toContain(DEAD);
    }
  });

  it("are never written by hand under the dead prefix", () => {
    const root = new URL("../../src/claude-readiness/", import.meta.url);
    for (const name of readdirSync(root, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!name.endsWith(".ts")) continue;
      expect(readFileSync(new URL(name, root), "utf8"), name).not.toContain(
        DEAD
      );
    }
  });

  it("are pinned to the date their page was read, or say they are not", () => {
    for (const page of CLAUDE_POLICY_PAGES) {
      const { revision, snapshotDate } = CLAUDE_POLICY_MANIFEST[page];
      const hashed = /^[0-9a-f]{32}$/.test(revision ?? "");
      if (READ.includes(page)) {
        expect(snapshotDate, page).toBe(CLAUDE_POLICY_SNAPSHOT_DATE);
        if (!hashed) expect(revision, page).toBe(CLAUDE_POLICY_SNAPSHOT_DATE);
      } else {
        expect(snapshotDate < CLAUDE_POLICY_SNAPSHOT_DATE, page).toBe(true);
        if (!hashed) expect(revision, page).toBeNull();
      }
    }
  });

  it("ships the read pages at the URLs they were read at", () => {
    expect(CLAUDE_POLICY_SNAPSHOT_DATE).toBe("2026-11-13");
    expect(
      Object.fromEntries(
        READ.map((page) => [page, CLAUDE_POLICY_MANIFEST[page].url])
      )
    ).toEqual({
      directory: "https://claude.com/docs/directory/publish",
      verification: "https://claude.com/docs/connectors/verification",
      submission: "https://claude.com/docs/connectors/building/submission",
      "review-criteria":
        "https://claude.com/docs/connectors/building/review-criteria",
      authentication:
        "https://claude.com/docs/connectors/building/authentication",
    });
  });
});

describe("OpenAI citations", () => {
  it("cite the guidelines at plugin-guidelines, where app-guidelines redirects", () => {
    expect(OPENAI_PLUGINS_POLICY_PAGES).toContain("plugin-guidelines");
    expect(OPENAI_PLUGINS_POLICY_PAGES).not.toContain("app-guidelines");
    expect(OPENAI_POLICY_MANIFEST["plugin-guidelines"].url).toBe(
      "https://developers.openai.com/plugins/plugin-guidelines"
    );
  });
});
