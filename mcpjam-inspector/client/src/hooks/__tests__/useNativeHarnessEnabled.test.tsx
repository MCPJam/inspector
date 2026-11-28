import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ value: {} as Record<string, boolean | undefined> }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) => flags.value[key],
}));
const templates = vi.hoisted(() => ({
  claudeCode: false,
  codex: false,
  cursor: false,
  copilotCli: undefined as boolean | undefined,
}));
vi.mock("../useClaudeCodeHostEnabled", () => ({
  useClaudeCodeHostEnabled: () => templates.claudeCode,
}));
vi.mock("../useCodexHostEnabled", () => ({
  useCodexHostEnabled: () => templates.codex,
}));
vi.mock("../useCursorHostEnabled", () => ({
  useCursorHostEnabled: () => templates.cursor,
}));
vi.mock("../useCopilotCliEnabled", () => ({
  useCopilotCliEnabled: () => templates.copilotCli,
}));

import { useNativeHarnessEnabled } from "../useNativeHarnessEnabled";

const enabled = () => renderHook(() => useNativeHarnessEnabled()).result.current;

beforeEach(() => {
  flags.value = {};
  Object.assign(templates, {
    claudeCode: false,
    codex: false,
    cursor: false,
    copilotCli: undefined,
  });
});

describe("useNativeHarnessEnabled", () => {
  it("is off with no native harness flag, and while flags load", () => {
    expect(enabled()).toBe(false);
  });

  it("is on for a paired client's client-agent-loop", () => {
    flags.value = { "client-agent-loop": true };
    expect(enabled()).toBe(true);
  });

  it.each(["claudeCode", "codex", "cursor"] as const)(
    "is on for a harness template's own runtime flag: %s",
    (template) => {
      templates[template] = true;
      expect(enabled()).toBe(true);
    },
  );

  it("is on for GitHub Copilot CLI's flag", () => {
    templates.copilotCli = true;
    expect(enabled()).toBe(true);
  });
});
