import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchWorkspaceCandidate } from "../../../../../bin/launch-workspace.mjs";
import { resolveSuggestedWorkspace } from "../suggested-workspace.js";

/**
 * Which folder the dialog offers, and why it is never guessed.
 *
 * The failure this is written against is specific: `bin/start.js` spawns the
 * server with `cwd: projectRoot` — the installed package's own directory — so
 * anything derived from the server's `process.cwd()` names
 * `.../node_modules/@mcpjam/inspector`. That is a real directory that looks
 * plausible in a dialog and is never what a user meant by "my project".
 */

let base: string;
let project: string;
let packageRoot: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-launch-")));
  project = join(base, "code", "my-project");
  packageRoot = join(base, "node_modules", "@mcpjam", "inspector");
  await mkdir(project, { recursive: true });
  await mkdir(packageRoot, { recursive: true });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("what an npx launcher captures", () => {
  it("suggests the directory the user actually ran the command in", async () => {
    expect(
      launchWorkspaceCandidate({
        projectRoot: packageRoot,
        cwd: project,
        env: {},
      }),
    ).toBe(await realpath(project));
  });

  it("never suggests the installed package's own root", () => {
    // The whole reason this value is captured in the launcher rather than read
    // by the server: a globally-installed wrapper leaves the package root as
    // the cwd, and the server's own cwd is that directory by construction.
    expect(
      launchWorkspaceCandidate({
        projectRoot: packageRoot,
        cwd: packageRoot,
        env: {},
      }),
    ).toBeNull();
  });

  it.each([
    ["the home directory", homedir()],
    ["the filesystem root", sep],
  ])("has no default for %s", (_label, cwd) => {
    // `registerWorkspaceGrant` refuses both, so suggesting one produces a
    // folder the user picks and the server then rejects — worse than asking.
    expect(
      launchWorkspaceCandidate({ projectRoot: packageRoot, cwd, env: {} }),
    ).toBeNull();
  });

  it("has no default when the invocation folder no longer resolves", () => {
    expect(
      launchWorkspaceCandidate({
        projectRoot: packageRoot,
        cwd: join(base, "deleted-since"),
        env: {},
      }),
    ).toBeNull();
  });

  it("has no default under Electron, which asks with its own picker", () => {
    expect(
      launchWorkspaceCandidate({
        projectRoot: packageRoot,
        cwd: project,
        env: { ELECTRON_APP: "true" },
      }),
    ).toBeNull();
  });
});

describe("what the server offers", () => {
  const display = (path: string) => `~${path.slice(base.length)}`;

  it("offers the launch workspace it was deliberately told about", async () => {
    await expect(
      resolveSuggestedWorkspace({
        env: { MCPJAM_LAUNCH_WORKSPACE: project },
        displayRoot: display,
      }),
    ).resolves.toMatchObject({ canonicalPath: await realpath(project) });
  });

  it("offers nothing when nobody passed one", async () => {
    // The dev server, a programmatic embed, and anything else nobody thought
    // about all land here — and all of them should ask rather than guess.
    await expect(
      resolveSuggestedWorkspace({ env: {}, displayRoot: display }),
    ).resolves.toBeNull();
  });

  it("never falls back to the server's own working directory", async () => {
    // The specific regression. Even standing in the package root, an
    // unset variable means no suggestion.
    const cwd = process.cwd();
    await expect(
      resolveSuggestedWorkspace({
        env: { NOT_THE_VARIABLE: cwd },
        displayRoot: display,
      }),
    ).resolves.toBeNull();
  });

  it("re-validates rather than trusting the variable", async () => {
    // A variable naming the home directory would otherwise be offered and then
    // refused at registration. Same rules, one place.
    await expect(
      resolveSuggestedWorkspace({
        env: { MCPJAM_LAUNCH_WORKSPACE: homedir() },
        displayRoot: display,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveSuggestedWorkspace({
        env: { MCPJAM_LAUNCH_WORKSPACE: join(base, "not-there") },
        displayRoot: display,
      }),
    ).resolves.toBeNull();
  });

  it("offers nothing on Electron even if the variable is set", async () => {
    await expect(
      resolveSuggestedWorkspace({
        env: { ELECTRON_APP: "true", MCPJAM_LAUNCH_WORKSPACE: project },
        displayRoot: display,
      }),
    ).resolves.toBeNull();
  });

  it("returns a display root and keeps the absolute path to itself", async () => {
    const suggested = await resolveSuggestedWorkspace({
      env: { MCPJAM_LAUNCH_WORKSPACE: project },
      displayRoot: display,
    });
    expect(suggested?.displayRoot.startsWith("~")).toBe(true);
    expect(suggested?.displayRoot).not.toContain(base);
  });
});
