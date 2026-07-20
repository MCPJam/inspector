import { describe, expect, it } from "vitest";
import { normalizeWidgetResourceReadResult } from "../use-widget-usage";

describe("normalizeWidgetResourceReadResult", () => {
  it("unwraps the inspector resources/read response", () => {
    const result = normalizeWidgetResourceReadResult({
      content: {
        contents: [{ text: "<html><body>Widget</body></html>" }],
      },
    });

    expect(result.contents?.[0]?.text).toContain("Widget");
  });

  it("keeps an already-unwrapped MCP result compatible", () => {
    const result = normalizeWidgetResourceReadResult({
      contents: [{ text: "<html><body>Widget</body></html>" }],
    });

    expect(result.contents?.[0]?.text).toContain("Widget");
  });
});
