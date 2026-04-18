import { describe, expect, it } from "vitest";
import { getDefaultHostedModelId } from "../drafts";

describe("getDefaultHostedModelId", () => {
  it("defaults to GPT-5 Mini, not the first MCPJam model in the catalog (gpt-oss)", () => {
    expect(getDefaultHostedModelId()).toBe("openai/gpt-5-mini");
    expect(getDefaultHostedModelId()).not.toBe("openai/gpt-oss-120b");
  });
});
