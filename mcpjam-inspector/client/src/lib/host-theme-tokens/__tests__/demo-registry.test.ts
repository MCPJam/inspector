import { describe, expect, it } from "vitest";
import {
  demoPriorCaptures,
  hostStyleHasDemoHistory,
} from "../demo-registry";

const latest = {
  "--color-background-primary": "light-dark(#fff, #111)",
  "--border-radius-lg": "10px",
};

describe("demoPriorCaptures", () => {
  it("returns two dated captures for ChatGPT and Claude", () => {
    expect(hostStyleHasDemoHistory("chatgpt")).toBe(true);
    expect(hostStyleHasDemoHistory("claude")).toBe(true);
    expect(demoPriorCaptures("claude", latest)).toHaveLength(2);
    expect(demoPriorCaptures("chatgpt", latest)[0]?.id).toBe("aug-4");
  });

  it("leaves hosts without a seeded timeline empty", () => {
    expect(hostStyleHasDemoHistory("mcpjam")).toBe(false);
    expect(demoPriorCaptures("mcpjam", latest)).toEqual([]);
  });

  it("mutates prior captures away from latest", () => {
    const [aug] = demoPriorCaptures("claude", latest);
    expect(aug.variables["--border-radius-lg"]).toBe("8px");
    expect(aug.variables["--color-background-primary"]).not.toBe(
      latest["--color-background-primary"],
    );
  });
});
