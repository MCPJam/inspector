import { describe, expect, it } from "vitest";
import {
  CHATGPT_PLUGIN_FLOW,
  CLAUDE_CONNECTOR_FLOW,
  type PlacedFinding,
} from "@mcpjam/sdk";

import {
  changedFindingInputs,
  submissionFindingInputs,
} from "../submission-finding-inputs.js";

type DirectoryReadinessFinding = PlacedFinding["finding"];

const finding: DirectoryReadinessFinding = {
  id: "openai.package.manifest",
  lane: "plugin-package",
  class: "required",
  status: "satisfied",
  title: "Manifest",
  source: {},
  provenance: "static",
  intrusiveness: "passive",
  evaluatedAt: "2026-11-13T00:00:00.000Z",
  engineVersion: "test",
};

describe("durable finding input fingerprints", () => {
  it("invalidates a package finding when the selected version changes", () => {
    const context = {
      flow: CHATGPT_PLUGIN_FLOW,
      answers: [],
      pluginVersionId: "version-a",
    };
    const stored = {
      ...finding,
      inputs: submissionFindingInputs(finding, context),
    };
    expect(changedFindingInputs(stored, context)).toEqual([]);
    expect(
      changedFindingInputs(stored, {
        ...context,
        pluginVersionId: "version-b",
      }),
    ).toEqual(["pluginVersionId"]);
  });

  it("leaves unrelated findings current after a package change", () => {
    const endpoint = { ...finding, id: "openai.endpoint.https" };
    const context = {
      flow: CHATGPT_PLUGIN_FLOW,
      answers: [],
      pluginVersionId: "version-a",
    };
    const stored = {
      ...endpoint,
      inputs: submissionFindingInputs(endpoint, context),
    };
    expect(
      changedFindingInputs(stored, {
        ...context,
        pluginVersionId: "version-b",
      }),
    ).toEqual([]);
  });

  it("invalidates persisted findings when the rules change", () => {
    const context = {
      flow: CLAUDE_CONNECTOR_FLOW,
      answers: [],
      flowVersion: "older-rules",
    };
    const stored = {
      ...finding,
      inputs: submissionFindingInputs(finding, context),
    };
    expect(
      changedFindingInputs(stored, {
        ...context,
        flowVersion: CLAUDE_CONNECTOR_FLOW.version,
      }),
    ).toEqual([CLAUDE_CONNECTOR_FLOW.id]);
  });
});
