import { describe, it, expect } from "vitest";
import { AlertTriangle, Info } from "lucide-react";
import { severityStyles } from "../error-card";

/**
 * The colours themselves, pinned at their source.
 *
 * Consumers assert that they wear whatever `severityStyles(severity)` hands
 * back, which keeps them in step with the palette but cannot notice the
 * palette moving underneath them: flip `info` to yellow and every one of those
 * loops stays self-consistent and green. Product's ask (BB-234) was for a
 * specific colour — blue reads as guidance, amber reads as an alarm on a
 * screen where nothing is wrong — so the hue is a requirement, and something
 * has to fail when it changes. That something is here, next to the palette,
 * rather than duplicated into every surface that borrows it.
 *
 * Matched on the tailwind colour family rather than the exact shade and
 * opacity: retuning `bg-blue-500/10` to `bg-blue-600/15` is a design call
 * nobody should have to update a test for, but leaving the blue family is the
 * change these assertions exist to catch.
 */
describe("severityStyles palette", () => {
  it("keeps info blue and warning amber", () => {
    expect(severityStyles("info").container).toMatch(/\bbg-blue-/);
    expect(severityStyles("info").container).toMatch(/\bborder-blue-/);
    expect(severityStyles("warning").container).toMatch(/\bbg-amber-/);
    expect(severityStyles("error").container).toMatch(/\bbg-destructive\//);
  });

  it("pairs each severity with its own icon", () => {
    // Half of "reads as a warning" is the glyph. An `AlertTriangle` tinted
    // amber inside an otherwise blue band is exactly the alarm BB-234 set out
    // to remove, and it is a plausible revert rather than a hypothetical one:
    // the previous implementation used that icon.
    // Compared by identity rather than by `displayName`: lucide renamed this
    // glyph to `TriangleAlert` upstream and still exports the old alias, so
    // the name is version trivia where the component reference is the thing
    // actually being pinned.
    expect(severityStyles("info").icon).toBe(Info);
    expect(severityStyles("warning").icon).toBe(AlertTriangle);
    expect(severityStyles("info").iconClass).toMatch(/\btext-blue-/);
    expect(severityStyles("warning").iconClass).toMatch(/\btext-amber-/);
  });
});
