import { describe, expect, it } from "vitest";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";

describe("getChatboxShellStyle", () => {
  it("maps ChatGPT host accent to info blue, not the global warm primary", () => {
    const light = getChatboxShellStyle("chatgpt", "light") as Record<
      string,
      string
    >;
    expect(light["--primary"]).toBe("rgba(1, 105, 204, 1)");
    const dark = getChatboxShellStyle("chatgpt", "dark") as Record<
      string,
      string
    >;
    expect(dark["--primary"]).toBe("rgba(2, 133, 255, 1)");
  });

  it("maps Claude host accent to semantic warning (warm) border tone", () => {
    const light = getChatboxShellStyle("claude", "light") as Record<
      string,
      string
    >;
    expect(light["--primary"]).toBe("rgba(128, 92, 31, 1)");
    const dark = getChatboxShellStyle("claude", "dark") as Record<
      string,
      string
    >;
    expect(dark["--primary"]).toBe("rgba(168, 120, 41, 1)");
  });
});
