import { describe, it, expect } from "vitest";
import { navigationSections } from "../mcp-sidebar";

/**
 * Guards the Production Redesign nav grouping (BB-127): the sidebar is five
 * labeled sections in a fixed order, not a flat list. These assertions are the
 * design's contract — an item quietly moving between sections, or a section
 * losing its heading, changes the information architecture even though nothing
 * type-errors.
 */
describe("sidebar section grouping", () => {
  it("ships the five design sections, in order, each with a label", () => {
    expect(navigationSections.map((section) => section.label)).toEqual([
      "Explore",
      "Measure",
      "Verify",
      "Inspect",
      "Educate",
    ]);
    expect(navigationSections.every((section) => section.label.length > 0)).toBe(
      true
    );
  });

  it("places every item the design enumerates in its named section", () => {
    const titlesIn = (label: string) =>
      navigationSections
        .find((section) => section.label === label)!
        .items.map((item) => item.title);

    // The design lists only the always-on items; flag-gated additions
    // (Registry, Environments, Sessions, Compatibility) are asserted separately
    // below so this stays readable as "the design's list, in the design's order".
    expect(titlesIn("Explore")).toEqual(
      expect.arrayContaining(["Home", "Connect", "Playground"])
    );
    expect(titlesIn("Measure")).toEqual(
      expect.arrayContaining(["Acceptance Testing", "Swarms", "Evaluate"])
    );
    expect(titlesIn("Verify")).toEqual(
      expect.arrayContaining([
        "OAuth Debugger",
        "XAA Debugger",
        "Conformance",
      ])
    );
    expect(titlesIn("Inspect")).toEqual([
      "Tools",
      "Resources",
      "Prompts",
      "Tasks",
      // Same primitive as Tools, from the other side of the browser boundary:
      // what a live PAGE registers rather than what a server exposes.
      "WebMCP",
    ]);
    expect(titlesIn("Educate")).toEqual(["Learning"]);
  });

  it("keeps flag-gated items in the section that matches what they do", () => {
    const sectionOf = (title: string) =>
      navigationSections.find((section) =>
        section.items.some((item) => item.title === title)
      )?.label;

    expect(sectionOf("Registry")).toBe("Explore");
    expect(sectionOf("Environments")).toBe("Explore");
    // The cross-surface run feed belongs with the things it aggregates.
    expect(sectionOf("Sessions")).toBe("Measure");
    // Sibling of Conformance — both answer "is this implementation correct?".
    expect(sectionOf("Compatibility")).toBe("Verify");
  });

  it("labels User Testing as Acceptance Testing while keeping its route", () => {
    const item = navigationSections
      .flatMap((section) => section.items)
      .find((entry) => entry.url === "/user-testing");

    expect(item?.title).toBe("Acceptance Testing");
    expect(
      navigationSections
        .flatMap((section) => section.items)
        .map((entry) => entry.title)
    ).not.toContain("User Testing");
  });

  it("never lists the same title twice across sections", () => {
    const titles = navigationSections.flatMap((section) =>
      section.items.map((item) => item.title)
    );

    expect(titles).toHaveLength(new Set(titles).size);
  });
});
