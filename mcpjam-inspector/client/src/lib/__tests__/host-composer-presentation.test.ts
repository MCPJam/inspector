import { describe, expect, it } from "vitest";
import { hostComposerClasses } from "../host-composer-presentation";

describe("hostComposerClasses", () => {
  it("renders the ChatGPT composer chrome per theme", () => {
    expect(hostComposerClasses("chatgpt", true)).toBe(
      "scenario-host-composer rounded-[1.75rem] border border-white/10 bg-[#303030] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_24px_rgba(130,130,130,0.14)]",
    );
    expect(hostComposerClasses("chatgpt", false)).toBe(
      "scenario-host-composer rounded-[1.75rem] border border-neutral-200/90 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_22px_rgba(100,100,100,0.08)]",
    );
  });

  it("renders the Claude composer chrome per theme", () => {
    expect(hostComposerClasses("claude", true)).toBe(
      "scenario-host-composer rounded-[1.35rem] border-[#4b463d] bg-[#30302E] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_22px_rgba(120,120,120,0.12)]",
    );
    expect(hostComposerClasses("claude", false)).toBe(
      "scenario-host-composer rounded-[1.35rem] border border-[#DFDFDB] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_20px_rgba(110,110,110,0.08)]",
    );
  });

  it("falls back to the neutral composer without a host style", () => {
    expect(hostComposerClasses(null, true)).toBe(
      "rounded-3xl border border-border/40 bg-muted/70",
    );
  });
});
