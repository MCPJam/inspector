import { describe, expect, it } from "vitest";
import {
  buildWidgetModelContextSystemPrompt,
  validateWidgetModelContextEntries,
  WidgetModelContextValidationError,
} from "../chat-v2-orchestration";
import { upsertWidgetModelContextEntry } from "../../../client/src/lib/widget-model-context";

describe("widget model context as the host queues it", () => {
  it("takes an App's large-image context, with the same placeholder", () => {
    const context = {
      content: [
        { type: "image", mimeType: "image/png", data: "A".repeat(500_000) },
        { type: "text", text: "Selected part" },
      ],
    };
    // Sent raw, the image bytes alone would fail the turn.
    expect(() =>
      validateWidgetModelContextEntries([{ toolCallId: "call-1", context }]),
    ).toThrow(WidgetModelContextValidationError);
    const queued = upsertWidgetModelContextEntry(
      [],
      "call-1",
      context as never,
    );
    const prompt = buildWidgetModelContextSystemPrompt(
      validateWidgetModelContextEntries(queued),
    );
    expect(prompt).toContain("[image: image/png]");
    expect(prompt).toContain("Selected part");
  });
});
