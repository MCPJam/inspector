import { describe, expect, it } from "vitest";
import {
  DETECTION_MAX_BYTES,
  MCPJAM_YAML_MAX_BYTES,
  parseMcpjamYaml,
  detectCandidates,
  detectCandidatesWithReasons,
  makeOverrideResolver,
  RecipeResolutionError,
  resolveRecipe,
  resolveRecipeLadder,
  type DetectionInputs,
  type RepoFileEntry,
} from "../resolver";

// Detection is a HEURISTIC rung, so the tests pin the properties that make a
// guess safe to act on rather than "does it guess right":
//
//   1. a candidate always RUNS THE CHECKOUT — anything that would launch a
//      published package or fetch a remote URL is discarded, because a green
//      check on someone else's artifact is worse than no check;
//   2. only the v1 ecosystems produce candidates, and everything else says so
//      by name (the corpus report counts those reasons);
//   3. evidence never carries untrusted file content (same rule as R1);
//   4. the authoritative rungs are untouched — an invalid mcpjam.yaml still
//      throws instead of quietly falling through to a guess.
//
// The policy is an ALLOWLIST ("prove it runs the checkout"), not a blocklist
// ("reject the launchers we thought of") — see detect.ts's docblock for why
// three rounds of bypasses forced that inversion. The suites below are
// organised around it: each of the three bypasses gets a named case AND the
// class it represents, because pinning only the reported spelling would repeat
// the mistake that made the inversion necessary. The last suite pins the other
// half of the bargain: the inversion must not tank recall on ordinary repos.

const EMPTY: DetectionInputs = {
  packageJson: null,
  packageLockJson: null,
  pnpmLockYaml: null,
  yarnLock: null,
  pyprojectToml: null,
  uvLock: null,
  serverJson: null,
  readme: null,
};

function inputs(overrides: Partial<DetectionInputs>): DetectionInputs {
  return { ...EMPTY, ...overrides };
}

// Listing entries. The KIND is the load-bearing half of `repoFiles` — a
// path-only listing cannot tell a regular `server.js` from a symlink into
// `node_modules/`, which is why the contract carries a type per entry.
const tracked = (...paths: string[]): RepoFileEntry[] =>
  paths.map((path) => ({ path, kind: "file" as const }));
const symlinked = (path: string): RepoFileEntry => ({ path, kind: "symlink" });

const PKG = JSON.stringify({
  name: "acme-mcp-server",
  scripts: { build: "tsc", start: "node dist/index.js" },
  // Any package under the official scope is the MCP signal, not the one exact
  // sdk name — `server-everything` exercises the same detection branch.
  dependencies: { "@modelcontextprotocol/server-everything": "^1.0.0" },
});

describe("detectCandidates — package managers", () => {
  it("npm: package-lock.json -> npm ci", () => {
    const [candidate] = detectCandidates(
      inputs({ packageJson: PKG, packageLockJson: "{}" }),
    );
    expect(candidate).toMatchObject({
      build: "npm ci && npm run build",
      start: "npm start",
      port: 3001,
      mcpPath: "/mcp",
      rung: "detected",
    });
  });

  it("pnpm: pnpm-lock.yaml -> frozen pnpm install", () => {
    const [candidate] = detectCandidates(
      inputs({ packageJson: PKG, pnpmLockYaml: "lockfileVersion: '9.0'\n" }),
    );
    expect(candidate.build).toBe("pnpm install --frozen-lockfile && pnpm run build");
    expect(candidate.start).toBe("pnpm start");
  });

  it("yarn classic: yarn.lock -> frozen yarn install", () => {
    const [candidate] = detectCandidates(
      inputs({ packageJson: PKG, yarnLock: "# yarn lockfile v1\n" }),
    );
    expect(candidate.build).toBe("yarn install --frozen-lockfile && yarn run build");
    expect(candidate.start).toBe("yarn start");
  });

  it("no lockfile still yields a candidate, using npm install and ranked below one", () => {
    const noLock = detectCandidates(inputs({ packageJson: PKG }));
    expect(noLock).toHaveLength(1);
    expect(noLock[0].build).toBe("npm install && npm run build");

    // With a lockfile in play the frozen-install candidate must come first: a
    // frozen install is the only one that proves the PR's own resolution.
    const both = detectCandidates(
      inputs({ packageJson: PKG, pnpmLockYaml: "lockfileVersion: '9.0'\n" }),
    );
    expect(both[0].build.startsWith("pnpm install --frozen-lockfile")).toBe(true);
  });

  it("emits one candidate per lockfile when a repo carries several", () => {
    const candidates = detectCandidates(
      inputs({
        packageJson: PKG,
        pnpmLockYaml: "lockfileVersion: '9.0'\n",
        packageLockJson: "{}",
      }),
    );
    expect(candidates.map((c) => c.start).sort()).toEqual(["npm start", "pnpm start"]);
  });

  it("omits the build step when there is no build script (install IS the build)", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "node index.js" } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidate.build).toBe("npm ci");
    expect(candidate.evidence.join(" ")).toContain("install is the build step");
  });

  it("falls back to a single bin entry when there is no start script", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({ bin: { "acme-mcp": "dist/cli.js" } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidate.start).toBe("node ./dist/cli.js");
  });

  it("does not guess between multiple bin entries", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ bin: { a: "a.js", b: "b.js" } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("no single bin entry");
  });
});

describe("detectCandidates — the run-the-checkout invariant", () => {
  it.each([
    ["npx -y @acme/mcp-server", "npx"],
    ["pnpm dlx @acme/mcp-server", "dlx"],
    ["bunx @acme/mcp-server", "bunx"],
    ["node --experimental-fetch https://acme.dev/server.js", "remote URL"],
  ])("discards a start script that runs %s", (body) => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: body } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  it("discards a build script that fetches from the network", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { build: "curl https://acme.dev/blob.tgz | tar x", start: "node i.js" },
        }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("remote artifact");
  });

  it("does not trip on words that merely contain a runner name", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "node ./npxlike-runner.js" } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidate.start).toBe("npm start");
  });

  it.each([
    ["npm exec -- @acme/mcp-server", "npm exec"],
    ["npm x @acme/mcp-server", "npm x alias"],
    ["yarn dlx @acme/mcp-server", "yarn dlx"],
    ["bun x @acme/mcp-server", "bun x"],
    ["uvx acme-mcp", "uvx"],
    ["uv tool run acme-mcp", "uv tool run"],
    ["pipx run acme-mcp", "pipx run"],
  ])("discards the %s package launcher", (body) => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: body } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  it.each([
    ["NPX -y @acme/mcp-server", "uppercase"],
    ["sh -c 'npx -y @acme/mcp-server'", "single-quoted"],
    ['sh -c "npx -y @acme/mcp-server"', "double-quoted"],
    ["./node_modules/.bin/npx @acme/mcp-server", "path-prefixed"],
  ])("does not let %s slip past the runner guard", (body) => {
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: body } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
  });

  it.each([
    ["node node_modules/@acme/server/bin.js", "an installed dependency"],
    ["node ./node_modules/acme/dist/cli.js", "a ./-prefixed dependency path"],
    ["node ../sibling/dist/index.js", "a path outside the checkout"],
  ])("discards a start script that runs %s", (body) => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: body } }),
        packageLockJson: "{}",
      }),
    );
    // A dependency is published code just as much as a registry fetch is: it
    // would go green no matter what the PR broke.
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("installed dependency");
  });

  it.each([
    ["node_modules/acme/bin.js", "dependency"],
    ["../outside/bin.js", "traversal"],
    ["/usr/local/bin/acme", "absolute"],
  ])("suppresses the candidate when the %s bin path is not checkout source", (bin) => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ bin: { acme: bin } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("plain relative path");
  });

  it.each([
    "dist/x$(id).js",
    "dist/x`id`.js",
    'dist/x";id;".js',
    "dist/x$HOME.js",
    "dist/x;rm -rf /.js",
  ])("rejects a hostile bin path (%s) rather than quoting it", (bin) => {
    // `start` runs under `bash -lc`, where double quotes still expand `$(…)`,
    // backticks and `$VAR` — quoting is not escaping, so the only safe answer
    // is to refuse the value.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ bin: { acme: bin } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("plain relative path");
  });

  it("does not emit a python candidate whose entry point is not a local module", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        pyprojectToml:
          '[project]\n[project.scripts]\nacme = "../vendor/thing.py"\n',
        uvLock: "version = 1\n",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("local module reference");
  });

  it("never emits a candidate from server.json packages[] alone", () => {
    // server.json describes PUBLISHED artifacts; it must not become a recipe.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        serverJson: JSON.stringify({
          name: "io.acme/server",
          packages: [{ registryType: "npm", identifier: "@acme/mcp-server" }],
        }),
      }),
    );
    expect(candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The inversion: the three reported bypasses, and the CLASS each belongs to.
// ---------------------------------------------------------------------------

describe("inverted policy — rule B: fetching subcommand anywhere in the tokens", () => {
  // FINDING 1: `npm --yes exec -- @acme/mcp-server`. An adjacency-based regex
  // needs `npm` and `exec` to be neighbours; there is an unbounded supply of
  // options to put between them, so the check is now token-based.
  it.each([
    ["npm --yes exec -- @acme/mcp-server", "the reported bypass"],
    ["npm -y x @acme/mcp-server", "short option before the alias"],
    ["npm exec @acme/mcp-server", "no option at all"],
    ["npm --loglevel warn exec @acme/mcp-server", "an option that takes a value"],
    ["npm --yes --silent --loglevel=warn exec -- @acme/mcp-server", "several options"],
    ["npm exec --yes -- @acme/mcp-server", "option after the subcommand"],
    ["pnpm --silent dlx @acme/mcp-server", "pnpm dlx with an option"],
    ["yarn --cwd . dlx @acme/mcp-server", "yarn dlx with an option"],
    ["bun --bun x @acme/mcp-server", "bun x with an option"],
    ["pipx --quiet run acme-mcp", "pipx run with an option"],
    ["uv run --from acme-mcp acme", "uv run --from, which fetches despite `run`"],
    ["uv run --with acme-mcp acme", "uv run --with"],
  ])("suppresses %s", (body) => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: body } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  it("still allows the non-fetching runners it deliberately permits", () => {
    // `pnpm exec` / `yarn run` / `bun run` / bare `uv run` execute what is
    // already resolved into the project. Banning them would discard the
    // ordinary `"build": "tsc"` shape for no safety gain.
    for (const build of ["pnpm exec tsc", "yarn run compile", "bun run build.ts"]) {
      const [candidate] = detectCandidates(
        inputs({
          packageJson: JSON.stringify({ scripts: { build, start: "node dist/i.js" } }),
          pnpmLockYaml: "lockfileVersion: '9.0'\n",
        }),
      );
      expect(candidate?.start).toBe("pnpm start");
    }
  });
});

describe("inverted policy — rule A: shell-computed commands are unprovable", () => {
  // FINDING 2: `node "$(npm root)"/@acme/server/bin.js`. The entry path does
  // not exist as a literal in the script — the shell builds it at runtime and
  // it lands on an installed package. No path check can see it, so the class of
  // "commands that compute themselves" is refused wholesale.
  it.each([
    ['node "$(npm root)"/@acme/server/bin.js', "the reported bypass"],
    ["node `npm root`/@acme/server/bin.js", "backtick substitution"],
    ["node ${NODE_MODULES}/@acme/server/bin.js", "parameter expansion"],
    ["node $HOME/server/bin.js", "bare variable"],
    ["node ~/server/bin.js", "home expansion"],
    ["cat pkg | sh", "a pipe"],
    ["true; node dist/index.js", "a chained command"],
    ["node dist/index.js && node other.js", "an && chain"],
    ["(cd packages/server && node dist/index.js)", "a subshell"],
    ["node dist/*.js", "a glob"],
    ["node dist/index.js > /dev/null", "a redirection"],
    ["node dist/{a,b}.js", "brace expansion"],
  ])("suppresses %s", (body) => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: body } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("cannot be established");
  });

  it("leaves the BUILD script free to chain and expand", () => {
    // A misbehaving build yields `build_failed` — a red check with honest
    // blame. Only an unanalysable START can produce a green on unknown code.
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({
          scripts: { build: "rm -rf dist && tsc -p . > build.log", start: "node dist/i.js" },
        }),
        packageLockJson: "{}",
      }),
    );
    expect(candidate.build).toBe("npm ci && npm run build");
  });
});

describe("inverted policy — rule C: entry points verified against the checkout", () => {
  const PKG_NO_BUILD = JSON.stringify({ scripts: { start: "node server/main.js" } });

  it("accepts an entry point that is present in the checkout", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: PKG_NO_BUILD,
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "server/main.js"),
      }),
    );
    expect(candidate.start).toBe("npm start");
  });

  it("suppresses an entry point that is absent from the checkout", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: PKG_NO_BUILD,
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "README.md"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("not proven to be checkout code");
  });

  it("accepts a build OUTPUT that no listing can contain, but only as UNVERIFIED", () => {
    // `node dist/index.js` after `npm run build` is the most common shape in
    // the ecosystem, and `dist/` is by definition not committed. Requiring it
    // in the listing would suppress nearly every node repo for no safety gain.
    // But the build script does NOT prove the output is checkout-derived, so
    // the candidate is emitted carrying the debt rather than a false claim.
    const [candidate] = detectCandidates(
      inputs({
        packageJson: PKG,
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "src/index.ts"),
      }),
    );
    expect(candidate.start).toBe("npm start");
    expect(candidate.ownershipProof).toBe("unverified");
  });

  it("marks an entry point PRESENT in the listing as verified", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: PKG_NO_BUILD,
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "server/main.js"),
      }),
    );
    expect(candidate.ownershipProof).toBe("verified");
  });

  it("applies the same rule to a bin entry", () => {
    const absent = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ bin: { acme: "dist/cli.js" } }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json"),
      }),
    );
    expect(absent.candidates).toEqual([]);
    expect(absent.discarded.join(" ")).toContain("not proven to be checkout code");

    const present = detectCandidates(
      inputs({
        packageJson: JSON.stringify({ bin: { acme: "cli.js" } }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "cli.js"),
      }),
    );
    expect(present[0].start).toBe("node ./cli.js");
  });

  it("falls back to the strict syntactic rules when no listing is supplied", () => {
    // No listing is a normal input (production callers have none until A3).
    // Node keeps working off the path rules; it does not become unusable — but
    // nothing was verified against anything, so it says so.
    const [candidate] = detectCandidates(
      inputs({ packageJson: PKG_NO_BUILD, packageLockJson: "{}" }),
    );
    expect(candidate.start).toBe("npm start");
    expect(candidate.ownershipProof).toBe("unverified");
  });
});

// The second review round on the allowlist itself. Each case below is a way
// rule C accepted on evidence that never established ownership; the fix is
// either a suppression or an honest 'unverified' label, never more string
// analysis of the same strings.
describe("rule C round 2 — evidence that only LOOKED like proof", () => {
  it("a build script alone does not make an absent entry VERIFIED", () => {
    // The reported case: `"build": "mkdir -p dist && cp
    // node_modules/acme/server.js dist/index.js"` copies PUBLISHED code into
    // `dist/index.js`. Nothing static can distinguish that build body from
    // `tsc`, so the output is never labelled verified on its account.
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "mkdir -p dist && cp node_modules/acme/server.js dist/index.js",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "src/index.ts"),
      }),
    );
    expect(candidate.ownershipProof).toBe("unverified");
  });

  it("suppresses an entry point the listing has as a SYMLINK", () => {
    // `server.js -> node_modules/acme/server.js` appears in `git ls-files` as
    // the harmless string "server.js". We do not chase the target and reason
    // about it: unresolvable provenance is a miss, and a miss is recoverable.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "node server.js" } }),
        packageLockJson: "{}",
        repoFiles: [...tracked("package.json"), symlinked("server.js")],
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("not proven to be checkout code");
  });

  it("a symlinked entry is suppressed even when a build step exists", () => {
    // The build-output leniency must not rescue a path the listing has already
    // answered for. Present-but-not-a-regular-file is a NO, not a fall-through.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { build: "tsc", start: "node dist/index.js" },
        }),
        packageLockJson: "{}",
        repoFiles: [...tracked("package.json"), symlinked("dist/index.js")],
      }),
    );
    expect(candidates).toEqual([]);
  });

  it("suppresses a symlinked python entry module", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        pyprojectToml:
          '[project]\nname = "acme-mcp"\n\n[project.scripts]\nacme = "acme.server:main"\n',
        uvLock: "version = 1\n",
        repoFiles: [...tracked("pyproject.toml"), symlinked("acme/server.py")],
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("dependency module");
  });

  it("suppresses a BARE-WORD start command when a listing is available", () => {
    // `start-server` resolves out of node_modules/.bin. It carries no script
    // extension, so it extracted zero entry paths and rule C never fired on it
    // — the node twin of the python `[project.scripts]` finding.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "start-server" } }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "src/index.ts"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("names no verifiable checkout file");
  });

  it("RESOLVES an indirection such as `npm run dev` instead of discarding it", () => {
    // Real corpus case (exa-labs/exa-mcp-server): `"start": "npm run dev"`.
    // Round 2 discarded every indirection wholesale, which lost this repo.
    // Round 3 follows the reference and applies the full rule set to what it
    // lands on — `tsx src/cli.ts`, a regular file in the listing — so the
    // candidate is emitted and PROVEN.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "npm run dev", dev: "tsx src/cli.ts" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "src/cli.ts"),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].start).toBe("npm start");
    expect(candidates[0].ownershipProof).toBe("verified");
  });

  it("keeps existing behavior for a bare-word start when there is NO listing", () => {
    // Without a listing there is nothing to check against, so the candidate is
    // still emitted — labelled unverified, which is what A3 gates on.
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "start-server" } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidate.start).toBe("npm start");
    expect(candidate.ownershipProof).toBe("unverified");
  });

  it.each([
    ["node .", tracked("package.json", "index.js")],
    ["node ./", tracked("package.json", "index.js")],
    ["node --enable-source-maps .", tracked("package.json", "index.js")],
    ["node bin/cli", tracked("package.json", "bin/cli")],
  ])("still accepts the extensionless-but-local start %s", (start, repoFiles) => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({ scripts: { start } }),
        packageLockJson: "{}",
        repoFiles,
      }),
    );
    expect(candidate?.start).toBe("npm start");
    expect(candidate?.ownershipProof).toBe("verified");
  });

  it.each([
    ["POSIX absolute", "node /etc/foo.js"],
    ["windows drive, forward slashes", "node C:/x.js"],
    ["windows drive, backslashes", "node C:\\x.js"],
    ["drive-relative", "node C:x.js"],
  ])("rejects an absolute entry path (%s)", (_label, start) => {
    // `escapesCheckout` only ever matched `node_modules/` and `../`, and the
    // build-output branch never checked relativity at all — so the docblock's
    // "a relative path can only resolve inside the checkout" was load-bearing
    // for a property nothing enforced.
    for (const repoFiles of [undefined, tracked("package.json", "src/index.ts")]) {
      const { candidates } = detectCandidatesWithReasons(
        inputs({
          packageJson: JSON.stringify({ scripts: { build: "tsc", start } }),
          packageLockJson: "{}",
          repoFiles,
        }),
      );
      expect(candidates).toEqual([]);
    }
  });

  it("rejects an absolute bin path", () => {
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          bin: { acme: "/opt/acme/cli.js" },
          scripts: { build: "tsc" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json"),
      }),
    );
    expect(candidates).toEqual([]);
  });

  it("treats an entry with an unclassifiable kind as unproven, not as a file", () => {
    // A submodule (gitlink) is someone else's commit. "We cannot classify it"
    // must never read as "regular file".
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "node vendor/server.js" } }),
        packageLockJson: "{}",
        repoFiles: [
          ...tracked("package.json"),
          { path: "vendor/server.js", kind: "other" },
        ],
      }),
    );
    expect(candidates).toEqual([]);
  });

  it("authoritative rungs are always verified", () => {
    const declared = resolveRecipe({
      repoFullName: "acme/mcp",
      mcpjamYaml:
        "version: 1\nchecks:\n  transport: streamable-http\n" +
        "  build: npm ci\n  start: npm start\n  port: 3001\n  path: /mcp\n",
    });
    expect(declared.ownershipProof).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// Round 3: `scripts.start` is not the only thing `npm start` runs.
//
// Two ways past rules A/B/C that never touched `scripts.start` at all:
// LIFECYCLE HOOKS (npm runs prestart before start) and SCRIPT INDIRECTION
// (`"start": "npm run serve"`). Round 2 read neither. The fix is not a bigger
// blocklist of spellings — it is to RESOLVE the reference and re-apply the
// rules, so that provable indirections are ACCEPTED (recall recovery) and
// unprovable ones are suppressed with their own legible reason.
// ---------------------------------------------------------------------------
describe("round 3 — lifecycle hooks", () => {
  const listing = tracked("package.json", "dist/index.js");

  it("suppresses a prestart that launches a published package", () => {
    // The whole finding in one fixture: `scripts.start` is impeccable, and
    // `npm start` still runs `npx @acme/server` first.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { prestart: "npx @acme/server", start: "node dist/index.js" },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("scripts.prestart");
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  it("suppresses a poststart that launches a published package", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "node dist/index.js", poststart: "npx @acme/server" },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("scripts.poststart");
  });

  it("suppresses a prestart that reaches a launcher through indirection", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            prestart: "npm run gen",
            gen: "npx @acme/codegen",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("script indirection, level 1");
  });

  it("ACCEPTS an ordinary build-tool prestart — rule C does not apply to hooks", () => {
    // `"prestart": "tsc"` is a bare word, which rule C would suppress. A hook
    // must EXIT before the probe connects, so it cannot be the server, and
    // suppressing build tools here would cost recall for no safety.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { prestart: "tsc", start: "node dist/index.js" },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownershipProof).toBe("verified");
    expect(candidates[0].evidence).toContain(
      "start lifecycle hooks verified against the same rules",
    );
  });

  it("suppresses a prestart that backgrounds or chains (rule A still applies)", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { prestart: "node vendor.js &", start: "node dist/index.js" },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("cannot be established");
  });

  it("suppresses an install hook that fetches AND detaches", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { postinstall: "npx @acme/server &", start: "node dist/index.js" },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("install lifecycle hook");
  });

  it("keeps ordinary install hooks — a FOREGROUND fetch cannot go falsely green", () => {
    // `npx playwright install` in a postinstall is everywhere. It either exits
    // or hangs the build; neither outcome is a green check on published code.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            postinstall: "npx playwright install",
            prepare: "husky install",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toHaveLength(1);
  });

  it("suppresses a prebuild that fetches a remote artifact", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            prebuild: "npx @acme/dist-bundle",
            build: "tsc",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("build lifecycle hook");
  });

  it("out-of-scope hooks do not run for anything we emit, so they are ignored", () => {
    // `prepublishOnly` / `prepack` / `pretest` never fire for `npm ci`,
    // `npm run build` or `npm start`. Suppressing on them would be theatre.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            prepublishOnly: "npx @acme/publisher",
            prepack: "npx @acme/packer",
            pretest: "npx @acme/server &",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toHaveLength(1);
  });
});

describe("round 3 — recursive script-reference resolution", () => {
  it("suppresses `start -> serve` when serve launches a published package", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "npm run serve", serve: "npx @acme/server" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("script indirection, level 1");
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  it("ACCEPTS `start -> serve` when serve runs a listed checkout file", () => {
    // The recall recovery. The recipe stays `npm start` — the recursion is a
    // VERIFICATION mechanism, not a rewriting one: emitting the resolved leaf
    // would skip `prestart` and drop npm's PATH/env, which is exactly what a
    // `tsx`/`ts-node` leaf depends on.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "tsc",
            start: "npm run serve",
            serve: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      build: "npm ci && npm run build",
      start: "npm start",
      ownershipProof: "verified",
    });
  });

  it("marks the resolved leaf unverified when only a build step could produce it", () => {
    // Same shape, but `dist/index.js` is not in the listing — accepted on the
    // build-output plausibility argument, and labelled so A3 settles it.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "tsc",
            start: "npm run serve",
            serve: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "src/index.ts"),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownershipProof).toBe("unverified");
  });

  it.each([
    ["pnpm run serve", "pnpmLockYaml"],
    ["pnpm serve", "pnpmLockYaml"],
    ["yarn run serve", "yarnLock"],
    ["yarn serve", "yarnLock"],
  ] as const)("follows `%s` too, not just `npm run X`", (body, lockKey) => {
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: body, serve: "npx @acme/server" },
        }),
        [lockKey]: "lock\n",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    // The leaf is a launcher, so every spelling of the hand-off must reach it.
    expect(candidates).toEqual([]);
  });

  it("follows every script named by npm-run-all / run-s", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "run-s prep serve",
            prep: "node scripts/prep.js",
            serve: "npx @acme/server",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "scripts/prep.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  it("suppresses a reference to a script that is not defined", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "npm run serve" } }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("is not defined");
  });

  it("suppresses a runner whose target cannot be determined statically", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "npm run" } }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("cannot be determined statically");
  });

  it("suppresses a chain deeper than the cap (4 hops)", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "npm run a",
            a: "npm run b",
            b: "npm run c",
            c: "npm run d",
            d: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain(
      "maximum resolvable script-indirection depth",
    );
  });

  it("resolves a chain AT the cap (3 hops)", () => {
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "npm run a",
            a: "npm run b",
            b: "npm run c",
            c: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownershipProof).toBe("verified");
  });

  it("terminates on a cycle instead of hanging", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "npm run a", a: "npm run b", b: "npm run a" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("cycle");
  });

  it("treats `npm start` inside scripts.start as the self-cycle it is", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({ scripts: { start: "npm start" } }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("cycle");
  });

  it("never puts a script NAME into a discard reason (evidence hygiene)", () => {
    // Reasons are rendered into GitHub check output, so they stay constant
    // strings plus validated integers — script names are PR content.
    const { discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "npm run pwned-script-name" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json"),
      }),
    );
    expect(discarded.join(" ")).not.toContain("pwned-script-name");
  });
});

// ---------------------------------------------------------------------------
// ROUND 3.1 — the four places round 3's own mechanism did not reach.
//
// Round 3 established the right move (RESOLVE the reference, re-apply the
// rules) and then applied it in fewer places than npm applies lifecycle hooks:
//
//   1. `pre<name>`/`post<name>` fire for ARBITRARY script names, at every depth
//      — not only for the root `start`;
//   2. the BUILD lifecycle read hook bodies literally, so one `npm run` hop
//      hid a fetch from rule B;
//   3. `npm ci` also fires `preprepare`/`postprepare`, which were not listed;
//   4. the install guard tested for a FETCH, but a bare dependency binary is
//      already on PATH by then and needs no fetch to answer the probe.
//
// Plus one correctness bug the mechanism carried from the start: script names
// were lowercased before a case-SENSITIVE package.json lookup.
// ---------------------------------------------------------------------------
describe("round 3.1 — nested pre/post hooks at every level of indirection", () => {
  const listing = tracked("package.json", "dist/index.js");

  it("suppresses a `preserve` that fetches and detaches behind `start -> serve`", () => {
    // The finding in one fixture: `serve` is impeccable and passes ownership
    // verification, and `npm run serve` still runs `preserve` first.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "npm run serve",
            preserve: "nohup npx @acme/server >/dev/null 2>&1 &",
            serve: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("script indirection, level 1");
  });

  it("suppresses a `postserve` that launches a published package", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "npm run serve",
            serve: "node dist/index.js",
            postserve: "npx @acme/server",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  it("ACCEPTS a benign nested hook — `\"preserve\": \"tsc\"` is a build tool", () => {
    // The other half of the bargain. A nested hook gets the same 'prepares'
    // role the root hooks get: rules A + B, not rule C, because it must exit
    // before the probe connects.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "tsc",
            start: "npm run serve",
            preserve: "tsc",
            serve: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      start: "npm start",
      ownershipProof: "verified",
    });
  });

  it("reaches a nested hook at depth 2", () => {
    // `start -> a -> b`, with the launcher parked in `preb`. Nothing about the
    // hazard is specific to the first hop.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "npm run a",
            a: "npm run b",
            preb: "nohup npx @acme/server &",
            b: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("script indirection, level 2");
  });

  it("follows the hooks of EVERY script named by a multi-script runner", () => {
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "run-s prep serve",
            prep: "node scripts/prep.js",
            preserve: "npx @acme/server",
            serve: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "scripts/prep.js", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
  });

  it("terminates on a cycle reached through a nested hook", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "npm run a",
            prea: "npm run a",
            a: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("cycle");
  });
});

describe("round 3.1 — build indirection", () => {
  const listing = tracked("package.json", "dist/index.js");

  it("suppresses `build -> bundle` when bundle fetches a remote artifact", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "npm run bundle",
            bundle: "npx @acme/dist-bundle",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("refusing to build from the network");
  });

  it("suppresses a fetch parked in the referenced script's OWN pre hook", () => {
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "npm run bundle",
            prebundle: "npx @acme/dist-bundle",
            bundle: "tsc",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
  });

  it("ACCEPTS benign build indirection", () => {
    // Following references must not turn ordinary `"build": "npm run compile"`
    // into a suppression — rule B is still the only rule applied here.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "npm run compile",
            compile: "tsc -p tsconfig.json",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].build).toBe("npm ci && npm run build");
  });

  it("leaves a CHAINED build alone — rule A does not apply to the build step", () => {
    // `tsc && chmod +x dist/cli.js` is the most ordinary build in the
    // ecosystem. An unresolvable reference in the build lifecycle is not a
    // rejection; a build that misbehaves is `build_failed`, an honest red.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            build: "tsc && chmod +x dist/index.js",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toHaveLength(1);
  });
});

describe("round 3.1 — the full npm install lifecycle", () => {
  const listing = tracked("package.json", "dist/index.js");

  it.each(["preprepare", "postprepare"])(
    "inspects `%s`, which npm ci runs and the old list omitted",
    (hook) => {
      const { candidates, discarded } = detectCandidatesWithReasons(
        inputs({
          packageJson: JSON.stringify({
            scripts: {
              [hook]: "nohup npx @acme/server >/dev/null 2>&1 &",
              start: "node dist/index.js",
            },
          }),
          packageLockJson: "{}",
          repoFiles: listing,
        }),
      );
      expect(candidates).toEqual([]);
      expect(discarded.join(" ")).toContain("install lifecycle hook");
    },
  );

  it("suppresses a DETACHED bare dependency binary — no fetch required", () => {
    // `acme-mcp-server` is already on PATH from node_modules/.bin by the time
    // install hooks run, so nothing is fetched and the fetch-only guard waved
    // it through. It can still be listening when the probe arrives.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            prepare: "nohup acme-mcp-server >/dev/null 2>&1 &",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("install lifecycle hook");
  });

  it("ACCEPTS a NON-detached bare binary — it must exit before the probe", () => {
    // `husky`/`patch-package`/`prisma generate` are the ecosystem. A
    // foreground binary cannot still be answering the port when start runs.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            prepare: "husky",
            postinstall: "patch-package",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toHaveLength(1);
  });

  it("ACCEPTS a detached CHECKOUT script — the runtime's argument is ours", () => {
    // `node scripts/watch.js &` backgrounds checkout code, which is not the
    // published-code hazard this guard exists for. The redirection fragments
    // (`2>&1`) must not be mistaken for command words either.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            postinstall: "node scripts/watch.js >/dev/null 2>&1 &",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js", "scripts/watch.js"),
      }),
    );
    expect(candidates).toHaveLength(1);
  });

  it("suppresses a detached explicit node_modules path", () => {
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            postinstall: "nohup ./node_modules/.bin/acme-server &",
            start: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: listing,
      }),
    );
    expect(candidates).toEqual([]);
  });
});

// Round 3.2. Three ways the install-hook guard could still be walked past,
// each a way of hiding WHICH token is the command or WHAT it will run.
describe("round 3.2 — install-hook guard: assignments, indirection, inline code", () => {
  const listing = tracked("package.json", "dist/index.js");

  /** A repo whose start command is honest, so only the hook is on trial. */
  const withScripts = (scripts: Record<string, string>, files = listing) =>
    detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "node dist/index.js", ...scripts },
        }),
        packageLockJson: "{}",
        repoFiles: files,
      }),
    );

  // --- environment assignments ------------------------------------------
  describe("environment assignments do not hide the command", () => {
    it("suppresses a PATH-valued assignment before a detached binary", () => {
      // The reported bypass. `FOO=/opt/x` contains a slash, so the old
      // "assignment means no slash" test read it as the COMMAND, found it did
      // not escape the checkout, and returned before reaching `acme-server`.
      const { candidates, discarded } = withScripts({
        prepare: "FOO=/opt/x nohup acme-server &",
      });
      expect(candidates).toEqual([]);
      expect(discarded.join(" ")).toContain("install lifecycle hook");
    });

    it("suppresses through SEVERAL leading assignments", () => {
      const { candidates } = withScripts({
        prepare: "A=1 B=/opt/x C=y-z nohup acme-server >/dev/null 2>&1 &",
      });
      expect(candidates).toEqual([]);
    });

    it("suppresses assignments introduced by `env`", () => {
      const { candidates } = withScripts({
        prepare: "env FOO=1 nohup acme-server &",
      });
      expect(candidates).toEqual([]);
    });

    it("ACCEPTS a benign assignment in front of checkout code", () => {
      // The recall side: `NODE_ENV=production node dist/index.js &` is the
      // repo backgrounding its OWN build, which is not the hazard.
      const { candidates } = withScripts({
        postinstall: "NODE_ENV=production node dist/index.js >/dev/null 2>&1 &",
      });
      expect(candidates).toHaveLength(1);
    });
  });

  // --- script-reference indirection --------------------------------------
  describe("install hooks follow script references", () => {
    it("suppresses a launch hidden one hop behind `npm run`", () => {
      const { candidates, discarded } = withScripts({
        prepare: "npm run sneaky",
        sneaky: "nohup acme-server &",
      });
      expect(candidates).toEqual([]);
      expect(discarded.join(" ")).toContain("script reference");
    });

    it("suppresses a launch in the referenced script's OWN pre/post hook", () => {
      for (const hook of ["presetup", "postsetup"]) {
        const { candidates } = withScripts({
          prepare: "npm run setup",
          setup: "tsc",
          [hook]: "nohup acme-server &",
        });
        expect(candidates).toEqual([]);
      }
    });

    it("ACCEPTS benign install-hook indirection", () => {
      const { candidates } = withScripts(
        { prepare: "npm run guard", guard: "node scripts/check.js" },
        tracked("package.json", "dist/index.js", "scripts/check.js"),
      );
      expect(candidates).toHaveLength(1);
    });

    it("terminates on a reference CYCLE instead of recursing forever", () => {
      const { candidates } = withScripts({
        prepare: "npm run a",
        a: "npm run b",
        b: "npm run a",
      });
      expect(candidates).toHaveLength(1);
    });

    it("follows to the depth cap, and stops there", () => {
      // At the cap the launch is still caught…
      const atCap = withScripts({
        prepare: "npm run a",
        a: "npm run b",
        b: "npm run c",
        c: "nohup acme-server &",
      });
      expect(atCap.candidates).toEqual([]);

      // …and one hop further we STOP walking rather than claim a depth of
      // reasoning we capped on purpose. Pinned as a known, bounded limit.
      const pastCap = withScripts({
        prepare: "npm run a",
        a: "npm run b",
        b: "npm run c",
        c: "npm run d",
        d: "nohup acme-server &",
      });
      expect(pastCap.candidates).toHaveLength(1);
    });
  });

  // --- inline-code runtimes ----------------------------------------------
  describe("detached local runtimes must be pointed at checkout code", () => {
    // The inline snippets below are deliberately free of parentheses and
    // semicolons. `shellSegments` splits on those, so `node -e
    // "require('acme').serve()"` fragments into a segment whose first word is
    // `acme` — which the bare-binary rule suppresses on its own, for a
    // tokenizing reason that has nothing to do with `-e`. Written that way the
    // test passes with the inline-flag rule REMOVED and proves nothing. An
    // ESM-style snippet leaves one clean segment, so only the flag rule can
    // suppress it.
    it.each([
      ["nohup node -e \"import 'acme/server'\" &", "-e"],
      ["nohup node --eval \"import 'acme/server'\" &", "--eval"],
      ['nohup node -p "process.env.PORT" &', "-p"],
      ['nohup node --print "process.env.PORT" &', "--print"],
      ["nohup node \"--eval=import 'acme/server'\" &", "--eval=CODE"],
    ])("suppresses a detached %s inline program", (body) => {
      const { candidates, discarded } = withScripts({ prepare: body });
      expect(candidates).toEqual([]);
      expect(discarded.join(" ")).toContain("install lifecycle hook");
    });

    it("suppresses python's inline-program flag `-c`", () => {
      // `python` is an accepted runtime, and a package.json script can call it.
      const { candidates } = withScripts({
        prepare: 'nohup python -c "import acme.server" &',
      });
      expect(candidates).toEqual([]);
    });

    it("suppresses python's installed-module flag `-m`", () => {
      // Not inline code, same hazard: `acme.server` is resolved from
      // site-packages, so no checkout listing can ever own it.
      const { candidates } = withScripts({
        prepare: "nohup python3 -m acme.server &",
      });
      expect(candidates).toEqual([]);
    });

    it("suppresses a detached runtime with NO entry argument", () => {
      const { candidates } = withScripts({
        prepare: "nohup node >/dev/null 2>&1 &",
      });
      expect(candidates).toEqual([]);
    });

    it("suppresses a detached runtime carrying ANY option", () => {
      // `--require` takes a value, so "first token without a leading dash" is
      // the OPTION'S VALUE, not the entry — the real entry sits beside it and
      // was never examined.
      expect(
        withScripts({
          prepare:
            "nohup node --require ./scripts/boot.js node_modules/acme/server.js &",
        }).candidates,
      ).toEqual([]);
      // Even an option whose value is benign: we refuse to guess which token
      // the runtime will treat as the entry.
      expect(
        withScripts({
          prepare: "nohup node --enable-source-maps dist/index.js &",
        }).candidates,
      ).toEqual([]);
    });

    it("suppresses a detached runtime pointed OUTSIDE the checkout", () => {
      expect(
        withScripts({ prepare: "nohup node /etc/evil.js &" }).candidates,
      ).toEqual([]);
      expect(
        withScripts({ prepare: "nohup node ../evil.js &" }).candidates,
      ).toEqual([]);
    });

    it("suppresses a detached runtime pointed at an ABSENT file", () => {
      // No build script here, so nothing could have produced it — the same
      // judgement `verifyEntryPath` makes for a start command.
      const { candidates } = withScripts({
        postinstall: "nohup node scripts/watch.js &",
      });
      expect(candidates).toEqual([]);
    });

    it("ACCEPTS a NON-detached `node -e` — it must exit before the probe", () => {
      // Pinned deliberately: the guard is about DETACHMENT. A foreground
      // `node -e` cannot still be listening when start runs, so inline code on
      // its own is not the hazard and suppressing it would cost recall.
      const { candidates } = withScripts({
        prepare: "node -e \"require('acme').warmup()\"",
      });
      expect(candidates).toHaveLength(1);
    });

    it("ACCEPTS a detached CHECKOUT entry point — the round-3.1 regression", () => {
      // `nohup node dist/index.js >/dev/null 2>&1 &` is the shape the previous
      // commit's tokenizer fix protected: the redirection fragments must not be
      // read as command words, and a tracked entry file is ours.
      const { candidates } = withScripts({
        postinstall: "nohup node dist/index.js >/dev/null 2>&1 &",
      });
      expect(candidates).toHaveLength(1);
    });
  });
});

describe("round 3.1 — script names are case-SENSITIVE", () => {
  it("resolves a mixed-case script name instead of missing it", () => {
    // `npm run Serve` runs `Serve`. Lowercasing the name made this a "script
    // is not defined" suppression on a perfectly good repo.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "npm run Serve", Serve: "node dist/index.js" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownershipProof).toBe("verified");
  });

  it("resolves the RIGHT one of a lowercase-colliding pair", () => {
    // Both spellings exist. `npm run Serve` must reach the launcher, not the
    // innocuous `serve` that happens to share its lowercase form — the failure
    // mode here is a false VERIFICATION, which is the dangerous direction.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "npm run Serve",
            Serve: "npx @acme/server",
            serve: "node dist/index.js",
          },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("published package or remote URL");
  });

  // The two tests below use a BENIGN referenced script on purpose. Pointing
  // them at a launcher and asserting `[]` proves nothing: a case-WRONG lookup
  // finds no script, discards for "not defined", and yields `[]` too — the
  // assertion holds whether or not the casing rule works. With a benign target
  // the two outcomes separate: a correct lookup resolves it and ACCEPTS, a
  // wrong lookup misses it and suppresses. Each keeps its suppression half as
  // a second case, so both directions stay covered.

  it("keeps the RUNNER and VERB case-insensitive", () => {
    // The filesystem and npm's command table resolve those; only the script
    // KEY is case-sensitive. If `NPM`/`RUN` were matched case-SENSITIVELY the
    // hand-off would not be recognised at all, the literal body `NPM RUN
    // serve` would be judged directly — no entry path, not a local runtime —
    // and there would be no candidate.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "NPM RUN serve", serve: "node dist/index.js" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownershipProof).toBe("verified");

    // …and the hand-off is really being FOLLOWED, not merely tolerated: the
    // same shape with a launcher behind it still suppresses.
    const hostile = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "NPM RUN serve", serve: "npx @acme/server" },
        }),
        packageLockJson: "{}",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(hostile.candidates).toEqual([]);
  });

  it("follows mixed-case names through pnpm's bare-script spelling", () => {
    // `pnpm Serve` runs `Serve`. There is deliberately NO lowercase `serve`
    // here: a lookup that lowercases finds nothing and suppresses, so the
    // accepted candidate is only reachable through the case-correct lookup.
    const { candidates } = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: { start: "pnpm Serve", Serve: "node dist/index.js" },
        }),
        pnpmLockYaml: "lock\n",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownershipProof).toBe("verified");

    // The colliding pair through the SAME pnpm path, which is the dangerous
    // direction: a lowercasing lookup would resolve the innocuous `serve` and
    // emit a candidate for a repo whose `Serve` launches a published package.
    const colliding = detectCandidatesWithReasons(
      inputs({
        packageJson: JSON.stringify({
          scripts: {
            start: "pnpm Serve",
            Serve: "npx @acme/server",
            serve: "node dist/index.js",
          },
        }),
        pnpmLockYaml: "lock\n",
        repoFiles: tracked("package.json", "dist/index.js"),
      }),
    );
    expect(colliding.candidates).toEqual([]);
    expect(colliding.discarded.join(" ")).toContain(
      "published package or remote URL",
    );
  });
});

describe("inverted policy — python [project.scripts] ownership", () => {
  const PY = (target: string) =>
    `[project]\nname = "acme-mcp"\n\n[project.scripts]\nacme = "${target}"\n`;

  // FINDING 3: `fastmcp.cli:main` has exactly the shape of a local entry point.
  // `module:attr` is a syntax; ownership is a fact about the checkout.
  it("suppresses a target that resolves to a DEPENDENCY module", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        pyprojectToml: PY("fastmcp.cli:main"),
        uvLock: "version = 1\n",
        repoFiles: tracked("pyproject.toml", "uv.lock", "acme/__init__.py"),
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("dependency module");
  });

  it("suppresses ALL python project scripts when there is no file listing", () => {
    // Without the checkout we cannot tell `fastmcp.cli:main` from
    // `acme.server:main`. A miss is recoverable; `uv run acme` starting fastmcp
    // and greening is not.
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({ pyprojectToml: PY("acme.server:main"), uvLock: "version = 1\n" }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("no file listing available");
  });

  it.each([
    ["acme/server.py", "flat module"],
    ["src/acme/server.py", "src layout"],
    ["acme/server/__init__.py", "package"],
    ["src/acme/server/__init__.py", "src-layout package"],
  ])("accepts a target proven local by %s", (path) => {
    const [candidate] = detectCandidates(
      inputs({
        pyprojectToml: PY("acme.server:main"),
        uvLock: "version = 1\n",
        repoFiles: tracked("pyproject.toml", path),
      }),
    );
    expect(candidate.start).toBe("uv run acme");
    expect(candidate.evidence.join(" ")).toContain("verified against the checkout");
  });
});

describe("inverted policy — recall on legitimate repos is not tanked", () => {
  // The other half of the bargain. Being aggressively conservative is only
  // defensible if ordinary repos still resolve; these are the shapes the corpus
  // is made of.
  const REAL_FILES = tracked("package.json", "src/index.ts", "README.md");

  it.each([
    ["npm", { packageLockJson: "{}" }, "npm ci && npm run build", "npm start"],
    [
      "pnpm",
      { pnpmLockYaml: "lockfileVersion: '9.0'\n" },
      "pnpm install --frozen-lockfile && pnpm run build",
      "pnpm start",
    ],
    [
      "yarn",
      { yarnLock: "# yarn lockfile v1\n" },
      "yarn install --frozen-lockfile && yarn run build",
      "yarn start",
    ],
  ])("%s: an ordinary repo still resolves, with and without a listing", (
    _pm,
    lock,
    build,
    start,
  ) => {
    for (const repoFiles of [undefined, REAL_FILES]) {
      const [candidate] = detectCandidates(
        inputs({ packageJson: PKG, ...lock, repoFiles }),
      );
      expect(candidate).toMatchObject({ build, start });
    }
  });

  it("uv: an ordinary python repo still resolves", () => {
    const [candidate] = detectCandidates(
      inputs({
        pyprojectToml:
          '[project]\nname = "acme-mcp"\n\n[project.scripts]\nacme-mcp = "acme.server:main"\n',
        uvLock: "version = 1\n",
        repoFiles: tracked("pyproject.toml", "uv.lock", "src/acme/server.py"),
      }),
    );
    expect(candidate).toMatchObject({ build: "uv sync --frozen", start: "uv run acme-mcp" });
  });

  it.each([
    "node dist/index.js",
    "node ./dist/index.js",
    "node build/server.js --port 3001",
    "node .",
    "node index.mjs",
    "tsx src/server.ts",
  ])("does not reject the ordinary start script %s", (body) => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: JSON.stringify({ scripts: { build: "tsc", start: body } }),
        packageLockJson: "{}",
      }),
    );
    expect(candidate?.start).toBe("npm start");
  });
});

describe("detectCandidates — ecosystems outside v1", () => {
  it("python with uv.lock yields a uv candidate", () => {
    const [candidate] = detectCandidates(
      inputs({
        pyprojectToml:
          '[project]\nname = "acme-mcp"\n\n[project.scripts]\nacme-mcp = "acme.server:main"\n',
        uvLock: "version = 1\n",
        // Required now: without a listing the target's OWNER is unknowable.
        repoFiles: tracked("pyproject.toml", "uv.lock", "acme/server.py"),
      }),
    );
    expect(candidate).toMatchObject({
      build: "uv sync --frozen",
      start: "uv run acme-mcp",
      rung: "detected",
    });
  });

  it("python without uv.lock yields nothing and names uv", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({
        pyprojectToml: '[project]\n[project.scripts]\nacme = "a:main"\n',
      }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("uv only");
  });

  it("poetry is called out by name rather than lumped in with 'unknown'", () => {
    const { discarded } = detectCandidatesWithReasons(
      inputs({
        pyprojectToml: '[tool.poetry]\nname = "acme"\n[project.scripts]\nacme = "a:main"\n',
      }),
    );
    expect(discarded.join(" ")).toContain("poetry");
  });

  it("go / rust / empty checkouts yield no candidate at all", () => {
    expect(detectCandidates(inputs({ readme: "# a go mcp server\n" }))).toEqual([]);
    expect(detectCandidates(EMPTY)).toEqual([]);
  });

  it("ignores a package.json that is not valid JSON, without throwing", () => {
    const { candidates, discarded } = detectCandidatesWithReasons(
      inputs({ packageJson: "{ not json", packageLockJson: "{}" }),
    );
    expect(candidates).toEqual([]);
    expect(discarded.join(" ")).toContain("unreadable");
  });

  it("ignores oversized input by BYTES, not code units", () => {
    // ~22k three-byte chars ≈ 66KB utf-8 but only ~22k code units.
    const padded = JSON.stringify({
      scripts: { start: "node i.js" },
      note: "€".repeat(22 * 1024),
    });
    expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(DETECTION_MAX_BYTES);
    expect(padded.length).toBeLessThan(DETECTION_MAX_BYTES);
    expect(detectCandidates(inputs({ packageJson: padded, packageLockJson: "{}" }))).toEqual([]);
  });
});

describe("detectCandidates — port/path hints", () => {
  it("server.json remotes[] overrides port and path", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: PKG,
        packageLockJson: "{}",
        serverJson: JSON.stringify({
          remotes: [{ type: "streamable-http", url: "http://localhost:8931/sse-mcp" }],
        }),
      }),
    );
    expect(candidate.port).toBe(8931);
    expect(candidate.mcpPath).toBe("/sse-mcp");
    // The command is untouched by the hint — that is the whole rule.
    expect(candidate.start).toBe("npm start");
  });

  it("README localhost URLs are a weaker hint, and only with a path", () => {
    const withPath = detectCandidates(
      inputs({
        packageJson: PKG,
        packageLockJson: "{}",
        readme: "Point your client at http://localhost:9000/mcp/v1 to connect.",
      }),
    )[0];
    expect(withPath.port).toBe(9000);
    expect(withPath.mcpPath).toBe("/mcp/v1");

    const bare = detectCandidates(
      inputs({
        packageJson: PKG,
        packageLockJson: "{}",
        readme: "The docs run at http://localhost:3000",
      }),
    )[0];
    expect(bare.port).toBe(3001);
    expect(bare.mcpPath).toBe("/mcp");
  });

  it.each([
    ["http://localhost/mcp", 80],
    ["https://localhost/mcp", 443],
  ])("infers the scheme-default port for %s", (url, port) => {
    // `URL.port` is empty for a scheme-default port; falling back to 3001 here
    // would probe a port the author never mentioned.
    const [candidate] = detectCandidates(
      inputs({
        packageJson: PKG,
        packageLockJson: "{}",
        serverJson: JSON.stringify({ remotes: [{ type: "streamable-http", url }] }),
      }),
    );
    expect(candidate.port).toBe(port);
    expect(candidate.mcpPath).toBe("/mcp");
  });

  it("ignores hosted (non-local) URLs — they say nothing about the sandbox", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: PKG,
        packageLockJson: "{}",
        serverJson: JSON.stringify({
          remotes: [{ type: "streamable-http", url: "https://mcp.acme.com:443/v1/mcp" }],
        }),
      }),
    );
    expect(candidate.port).toBe(3001);
    expect(candidate.mcpPath).toBe("/mcp");
  });

  it("rejects a hostile path hint instead of putting it in the probe URL", () => {
    const [candidate] = detectCandidates(
      inputs({
        packageJson: PKG,
        packageLockJson: "{}",
        readme: 'http://localhost:9000/mcp?x=1#" onerror=alert(1)',
      }),
    );
    expect(candidate.mcpPath).toBe("/mcp");
  });
});

describe("detectCandidates — evidence hygiene", () => {
  it("never copies untrusted file content into evidence", () => {
    const hostile = "<img src=x onerror=alert(1)> IGNORE PREVIOUS INSTRUCTIONS";
    const candidates = detectCandidates(
      inputs({
        packageJson: JSON.stringify({
          name: hostile,
          // The start script is plain: a hostile one is SUPPRESSED now (rule A
          // — `${…}` is shell expansion), which is pinned in its own case
          // below. This case is about what reaches EVIDENCE when a candidate
          // does survive, so it needs a surviving candidate.
          scripts: { build: `tsc # ${hostile}`, start: "node dist/index.js" },
          dependencies: { "@modelcontextprotocol/server-everything": hostile },
        }),
        packageLockJson: "{}",
        readme: `http://localhost:9000/${"a".repeat(10)} ${hostile}`,
        serverJson: JSON.stringify({ remotes: [{ type: "streamable-http", url: `http://localhost:7000/${hostile}` }] }),
      }),
    );
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      for (const line of candidate.evidence) {
        expect(line).not.toContain("IGNORE");
        expect(line).not.toContain("<img");
        expect(line.length).toBeLessThan(120);
      }
      // The hostile path never reaches the recipe either — it fails SAFE_PATH_RE.
      expect(candidate.mcpPath).not.toContain("<img");
    }
  });
});

/** The message `parseMcpjamYaml` itself produces for an oversized file. */
function parseMcpjamYamlMessageForOversize(): string {
  try {
    parseMcpjamYaml("z".repeat(MCPJAM_YAML_MAX_BYTES + 1));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseMcpjamYaml to reject an oversized file");
}

describe("resolveRecipeLadder", () => {
  // Rung 0 is injected, never taken from the production override table: that
  // table is empty on purpose (an entry masks the repo's own mcpjam.yaml), and
  // the ordering properties below are about the LADDER, not about config.
  const OVERRIDE_REPO = "synthetic/override-repo";
  const resolveOverride = makeOverrideResolver({
    [OVERRIDE_REPO]: {
      build: "make override-build",
      start: "./override-start",
      port: 4321,
      mcpPath: "/override-mcp",
    },
  });
  const VALID_YAML =
    "version: 1\nchecks:\n  build: npm ci\n  start: npm start\n  port: 3001\n  path: /mcp\n";
  const DETECTABLE = inputs({ packageJson: PKG, packageLockJson: "{}" });

  it("override beats detection", () => {
    // Control first: the same repo with the same detectable inputs and NO
    // override lands on candidates, so the assertion below is about rung 0.
    expect(
      resolveRecipeLadder({
        repoFullName: OVERRIDE_REPO,
        mcpjamYaml: null,
        detection: DETECTABLE,
      }).kind,
    ).toBe("candidates");

    const result = resolveRecipeLadder({
      repoFullName: OVERRIDE_REPO,
      mcpjamYaml: null,
      detection: DETECTABLE,
      resolveOverride,
    });
    expect(result).toMatchObject({
      kind: "authoritative",
      recipe: { rung: "override", port: 4321 },
    });
  });

  it("declared config beats detection", () => {
    const result = resolveRecipeLadder({
      repoFullName: "someone/some-server",
      mcpjamYaml: VALID_YAML,
      detection: DETECTABLE,
    });
    expect(result).toMatchObject({ kind: "authoritative", recipe: { rung: "declared" } });
  });

  it("an INVALID declared config still throws — no fall-through to detection", () => {
    // The R1 attribution contract, re-pinned now that a fallback exists: this
    // is exactly the regression a heuristic rung invites.
    let error: unknown;
    try {
      resolveRecipeLadder({
        repoFullName: "someone/some-server",
        mcpjamYaml: VALID_YAML.replace("version: 1", "version: 99"),
        detection: DETECTABLE,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RecipeResolutionError);
    expect((error as RecipeResolutionError).reason).toBe("invalid_mcpjam_yaml");
  });

  it("an OVER-CAP declared config throws too — it is invalid, not absent", () => {
    // The reader cannot pull an unbounded file across the command channel, so
    // it reports "present but over the cap" rather than the text. That must
    // reach the SAME verdict as handing the file to the parser: absence would
    // mean "this rung does not apply", and the ladder would run a heuristic
    // guess and report it under the author's name.
    let error: unknown;
    try {
      resolveRecipeLadder({
        repoFullName: "someone/some-server",
        mcpjamYaml: null,
        mcpjamYamlOverCap: true,
        detection: DETECTABLE,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RecipeResolutionError);
    expect((error as RecipeResolutionError).reason).toBe("invalid_mcpjam_yaml");
    // Same message the parser produces from the file itself.
    expect((error as RecipeResolutionError).message).toBe(
      parseMcpjamYamlMessageForOversize(),
    );
  });

  it("an over-cap declared config does NOT become a heuristic candidate", () => {
    // Stated as its own case because it is the actual defect: the repo below
    // detects cleanly, so an over-cap file collapsing to `null` produced a
    // green check on a command nobody declared.
    const withoutYaml = resolveRecipeLadder({
      repoFullName: "someone/some-server",
      mcpjamYaml: null,
      detection: DETECTABLE,
    });
    expect(withoutYaml.kind).toBe("candidates");
    expect(() =>
      resolveRecipeLadder({
        repoFullName: "someone/some-server",
        mcpjamYaml: null,
        mcpjamYamlOverCap: true,
        detection: DETECTABLE,
      }),
    ).toThrowError(RecipeResolutionError);
  });

  it("an operator override still outranks an over-cap declared config", () => {
    // The override rung comes FIRST, and an unreadable file below it changes
    // nothing about that ordering.
    const result = resolveRecipeLadder({
      repoFullName: OVERRIDE_REPO,
      mcpjamYaml: null,
      mcpjamYamlOverCap: true,
      detection: DETECTABLE,
      resolveOverride,
    });
    expect(result).toMatchObject({ kind: "authoritative" });
    if (result.kind !== "authoritative") throw new Error("unreachable");
    expect(result.recipe.evidence).toContain(
      "mcpjam.yaml present but outranked by override",
    );
  });

  it("returns detected candidates when nothing authoritative exists", () => {
    const result = resolveRecipeLadder({
      repoFullName: "someone/some-server",
      mcpjamYaml: null,
      detection: DETECTABLE,
    });
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") throw new Error("unreachable");
    expect(result.candidates[0].rung).toBe("detected");
  });

  it("nothing detectable -> no_recipe, with the discard reasons attached", () => {
    let error: RecipeResolutionError | undefined;
    try {
      resolveRecipeLadder({
        repoFullName: "someone/some-server",
        mcpjamYaml: null,
        detection: inputs({ pyprojectToml: "[project]\n" }),
      });
    } catch (err) {
      error = err as RecipeResolutionError;
    }
    expect(error?.reason).toBe("no_recipe");
    expect(error?.detailsMarkdown).toContain("uv only");
  });

  it("resolveRecipe keeps its R1 behavior (authoritative only, throws otherwise)", () => {
    expect(
      resolveRecipe({ repoFullName: "someone/some-server", mcpjamYaml: VALID_YAML }).rung,
    ).toBe("declared");
    expect(() =>
      resolveRecipe({ repoFullName: "someone/some-server", mcpjamYaml: null }),
    ).toThrowError(RecipeResolutionError);
  });
});
