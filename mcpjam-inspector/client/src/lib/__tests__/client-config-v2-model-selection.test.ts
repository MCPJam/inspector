import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import {
  emptyHostConfigInputV2,
  hostConfigInputsEqual,
} from "../client-config-v2";
import { changedClientSettings } from "@/components/hosts/redesigned/client-save-telemetry";

const ID = "anthropic/claude-haiku-4.5";
const ORG: ModelSelection = {
  modelId: ID,
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_1" },
  fallback: { provider: "none", model: "none" },
};
const HOSTED: ModelSelection = {
  modelId: ID,
  source: "hosted",
  fallback: { provider: "none", model: "none" },
};

describe("host config model selection", () => {
  const base = { ...emptyHostConfigInputV2(), modelId: ID };

  it("a different connection for the same id is a change", () => {
    expect(
      hostConfigInputsEqual(
        { ...base, modelSelection: ORG },
        { ...base, modelSelection: HOSTED },
      ),
    ).toBe(false);
    expect(
      hostConfigInputsEqual(
        { ...base, modelSelection: ORG },
        { ...base, modelSelection: { ...ORG } },
      ),
    ).toBe(true);
    expect(hostConfigInputsEqual(base, { ...base, modelSelection: ORG })).toBe(
      false,
    );
  });

  it("save telemetry reports one model change", () => {
    const changed = (draft: typeof base) =>
      changedClientSettings({
        savedName: "c",
        draftName: "c",
        savedConfig: { ...base, modelSelection: HOSTED },
        draftConfig: draft,
      }).filter((id) => id === "model");
    expect(changed({ ...base, modelSelection: ORG })).toEqual(["model"]);
    expect(
      changed({ ...base, modelId: "openai/gpt-4o", modelSelection: undefined }),
    ).toEqual(["model"]);
  });
});
