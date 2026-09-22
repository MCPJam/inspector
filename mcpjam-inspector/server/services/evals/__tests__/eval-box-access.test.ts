import { describe, expect, it } from "vitest";

import { evalBoxFilesystemIsReachable } from "../eval-box-access";

/**
 * Which per-run boxes get the case's attachments seeded onto them.
 *
 * The failure this pins is silent in both directions: seeding a box nothing
 * can read wastes an upload and annotates the prompt with paths the model
 * cannot open, while NOT seeding a box the harness can read produces a
 * perfectly ordinary-looking transcript of an agent that never saw its files.
 */
describe("evalBoxFilesystemIsReachable", () => {
  it("a TERMINAL box is reachable — that is what `bash` is", () => {
    expect(evalBoxFilesystemIsReachable({ runtimeKind: "terminal" })).toBe(
      true,
    );
    expect(
      evalBoxFilesystemIsReachable({
        runtimeKind: "terminal",
        harness: "claude-code",
      }),
    ).toBe(true);
  });

  it("a DESKTOP box with a harness on it is reachable", () => {
    // The case this function exists for. A harness eval that also declares a
    // browser policy boots a desktop box, and the harness runs ON it via
    // `harnessSandboxBinding` with its own file tools — the absence of `bash`
    // says nothing about whether the filesystem can be read.
    expect(
      evalBoxFilesystemIsReachable({
        runtimeKind: "desktop-browser",
        harness: "claude-code",
      }),
    ).toBe(true);
  });

  it("a DESKTOP box with no harness is NOT reachable", () => {
    // An emulated browser iteration holds `browser_*` and nothing else:
    // `browser` and `bash` are mutually exclusive on a host config, so there
    // is no tool on this box that opens a file.
    expect(
      evalBoxFilesystemIsReachable({ runtimeKind: "desktop-browser" }),
    ).toBe(false);
    expect(
      evalBoxFilesystemIsReachable({
        runtimeKind: "desktop-browser",
        harness: undefined,
      }),
    ).toBe(false);
  });
});
