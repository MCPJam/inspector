import { describe, expect, it } from "vitest";
import {
  addPreviewCase,
  buildEvalServerPreview,
  createDraftPreviewCase,
  createDraftPreviewSuite,
  findPreviewCase,
  hydratePreviewCase,
  previewCaseCount,
  removePreviewCase,
  removePreviewSuite,
  updatePreviewCase,
} from "../eval-server-preview-model";

describe("buildEvalServerPreview", () => {
  it("names the preview after the connected server and counts cases", () => {
    const preview = buildEvalServerPreview({
      id: "srv-asana",
      name: "Asana MCP",
    });

    expect(preview.serverId).toBe("srv-asana");
    expect(preview.serverName).toBe("Asana MCP");
    expect(preview.suites).toHaveLength(3);
    expect(previewCaseCount(preview)).toBe(15);
    expect(preview.findings.length).toBeGreaterThan(0);
    expect(
      preview.findings.some((finding) => finding.source === "discovery"),
    ).toBe(true);
    expect(
      preview.findings.some((finding) => finding.source === "connection"),
    ).toBe(true);
    expect(preview.findings.every((finding) => finding.severity)).toBeTruthy();
  });

  it("adds, updates, and removes suites and cases", () => {
    const preview = buildEvalServerPreview({
      id: "srv-asana",
      name: "Asana MCP",
    });
    const suiteId = preview.suites[0]!.id;
    const caseId = preview.suites[0]!.cases[0]!.id;

    const draftCase = createDraftPreviewCase("Draft case");
    const withCase = addPreviewCase(preview.suites, suiteId, draftCase);
    expect(findPreviewCase(withCase, suiteId, draftCase.id)?.title).toBe(
      "Draft case",
    );

    const renamed = updatePreviewCase(withCase, suiteId, draftCase.id, {
      title: "Renamed case",
    });
    expect(findPreviewCase(renamed, suiteId, draftCase.id)?.title).toBe(
      "Renamed case",
    );

    const withoutCase = removePreviewCase(renamed, suiteId, caseId);
    expect(findPreviewCase(withoutCase, suiteId, caseId)).toBeNull();

    const withoutSuite = removePreviewSuite(withoutCase, suiteId);
    expect(withoutSuite.find((suite) => suite.id === suiteId)).toBeUndefined();
    expect(createDraftPreviewSuite().draft).toBe(true);
    // Ids stay unique after a middle suite is deleted and another is added.
    expect(createDraftPreviewSuite().id).not.toBe(createDraftPreviewSuite().id);

    const hydrated = hydratePreviewCase({
      id: "case-1",
      title: "Create a task from a short brief",
    });
    expect(hydrated.prompt).toBe("Create a task from a short brief");
    expect(hydrated.steps?.length).toBeGreaterThan(0);
  });
});
