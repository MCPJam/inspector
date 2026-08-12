/**
 * What the Describe step says while it waits. The reported "hang" was a working
 * request with nothing to show for itself, so the line has to name the stage and
 * count real time — and, past the point where the wait itself needs explaining,
 * say that leaving costs nothing (the flow writes no rows until Launch).
 */
import { describe, expect, it } from "vitest";
import { generationProgressLine } from "../new-swarm-create-flow";

describe("generationProgressLine", () => {
  it("names the target stage before the model is called", () => {
    expect(
      generationProgressLine({
        stage: "targets",
        elapsedSeconds: 0,
        personaCount: 3,
        journeyCount: 5,
      })
    ).toBe("Preparing targets: resolving the environments to generate against.");
  });

  it("names the work the generation is doing, with the counts it was asked for", () => {
    expect(
      generationProgressLine({
        stage: "personas",
        elapsedSeconds: 0,
        personaCount: 3,
        journeyCount: 5,
      })
    ).toBe(
      "Writing 3 personas with up to 5 goals each, grounded on the target's tools."
    );
  });

  it("singularizes a one-persona, one-goal slate", () => {
    expect(
      generationProgressLine({
        stage: "personas",
        elapsedSeconds: 0,
        personaCount: 1,
        journeyCount: 1,
      })
    ).toContain("Writing 1 persona with up to 1 goal each");
  });

  it("shows elapsed time only once it is worth showing", () => {
    const line = (elapsedSeconds: number) =>
      generationProgressLine({
        stage: "personas",
        elapsedSeconds,
        personaCount: 3,
        journeyCount: 5,
      });

    expect(line(2)).not.toContain("elapsed");
    expect(line(3)).toContain("· 3s elapsed.");
    expect(line(12)).toContain("· 12s elapsed.");
  });

  it("explains a long wait instead of only counting it", () => {
    const line = generationProgressLine({
      stage: "personas",
      elapsedSeconds: 31,
      personaCount: 3,
      journeyCount: 5,
    });

    expect(line).toContain("31s elapsed");
    expect(line).toContain("Still waiting on the generator");
    expect(line).toContain("nothing is saved until you launch");
  });

  it("quotes no ETA — there is no honest one to quote", () => {
    for (const elapsedSeconds of [0, 5, 45]) {
      const line = generationProgressLine({
        stage: "personas",
        elapsedSeconds,
        personaCount: 3,
        journeyCount: 5,
      });
      expect(line).not.toMatch(/~|about \d|usually \d|remaining/i);
    }
  });
});
