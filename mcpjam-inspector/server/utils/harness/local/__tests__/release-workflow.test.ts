import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import { computePackInputs } from "../../../../../scripts/check-local-harness-inputs.mjs";

const workflowsDir = new URL("../../../../../../.github/workflows/", import.meta.url);
const workflow = (name: string) => parse(readFileSync(new URL(`${name}.yml`, workflowsDir), "utf8"));

describe("the layer digest helper", () => {
  it("generates the Codex bridge bundle before anything that imports it", () => {
    // release.yml's contract job runs only `npm ci` before computing layer
    // digests; release 3.14.0 failed there with ERR_MODULE_NOT_FOUND after
    // every platform had passed. The helper must not rely on its caller.
    const source = readFileSync(new URL("../../../../../scripts/inspector-layer-digests.mjs", import.meta.url), "utf8");
    const codex = source.indexOf("await bundleCodexAppServerBridge()");
    const layer = source.indexOf("await bundleLocalHarnessLayer()");
    const read = source.indexOf("inspector-layer-files.ts");
    expect(codex).toBeGreaterThan(-1);
    expect(codex).toBeLessThan(layer);
    expect(layer).toBeLessThan(read);
  });
});

describe("release critical path", () => {
  it("publishes npm and the webapp without waiting for the desktop builds", () => {
    // The desktop builds are mostly Apple's notary queue (10–25 min); they
    // gate only the GitHub release. The local runtime contract still gates
    // npm, which offers local execution too.
    const { jobs } = workflow("release");
    expect(jobs["artifact-gate"]).toBeUndefined();
    const publish = jobs["publish-packages"];
    expect(publish.needs).not.toContain("build-mac");
    expect(publish.needs).not.toContain("build-windows");
    expect(publish.needs).toContain("local-harness-contract");
    const gate = String(publish.if).replace(/\s+/g, " ");
    expect(gate).toContain(
      "( needs.preflight.outputs.publish_inspector != 'true' || (needs.local-harness-contract.result == 'success' && needs.harness-consistency.result == 'success') )",
    );
    expect(gate).not.toContain("build-mac");
  });

  it("creates the immutable GitHub release only once every desktop asset exists, desktop-only included", () => {
    const { jobs } = workflow("release");
    const finalize = jobs.finalize;
    expect(finalize.needs).toEqual(
      expect.arrayContaining(["build-mac", "build-windows", "local-harness-contract", "harness-consistency"]),
    );
    const gate = String(finalize.if).replace(/\s+/g, " ");
    expect(gate).toContain(
      "( needs.publish-packages.result == 'success' || needs.preflight.outputs.desktop_only == 'true' )",
    );
    expect(gate).toContain(
      "( needs.preflight.outputs.build_inspector_artifacts != 'true' || ( needs.build-mac.result == 'success' && needs.build-windows.result == 'success' && needs.local-harness-contract.result == 'success' && needs.harness-consistency.result == 'success' ) )",
    );
    // The plan comes from the tested script, and desktop-only is an output.
    const preflight = jobs.preflight;
    expect(preflight.outputs.desktop_only).toBe("${{ steps.plan.outputs.desktop_only }}");
    const plan = preflight.steps.find((step: any) => step.id === "plan");
    expect(plan.run).toContain("node .github/scripts/release-plan.mjs");
    // A desktop-only run still proves the local runtime its desktop app offers.
    for (const job of ["local-harness-evidence", "local-harness-evidence-permitted", "local-harness-contract", "harness-consistency"]) {
      expect(String(jobs[job].if), job).toContain("build_inspector_artifacts");
      expect(String(jobs[job].if), job).not.toContain("publish_inspector");
    }
  });

  it("fails the run when the versions it set out to ship did not reach npm", () => {
    const { jobs } = workflow("release");
    const shipped = jobs.shipped;
    expect(shipped.needs).toEqual(expect.arrayContaining(["preflight", "publish-packages", "finalize"]));
    expect(String(shipped.if)).toContain("!cancelled()");
    const run = shipped.steps[0].run as string;
    expect(run).toMatch(/"\$PUBLISH_ANY" = "true" \] && \[ "\$PUBLISHED" != "success"/);
    expect(run).toMatch(/exit 1/);
  });

  it("keeps the pack provenance check off the build path", () => {
    const { jobs } = workflow("release");
    const preflightRuns = jobs.preflight.steps.map((step: any) => step.run ?? "").join("\n");
    expect(preflightRuns).not.toMatch(/check-local-harness-release/);
    expect(jobs["harness-consistency"].needs).toBe("preflight");
    expect(jobs["publish-packages"].needs).toContain("harness-consistency");
  });

  it("points production's hosted computers at the released commit's template only after the webapp deploys", () => {
    const { jobs } = workflow("release");
    const job = jobs["roll-out-hosted-template"];
    expect(job.needs).toEqual(expect.arrayContaining(["preflight", "deploy-webapp"]));
    expect(String(job.if)).toContain("needs.deploy-webapp.result == 'success'");
    const script = job.steps.map((step: any) => step.with?.script ?? "").join("\n");
    expect(script).toContain('event_type: "inspector_release_shipped"');
    expect(script).toContain("sha: context.sha");
    // And main's bake inputs reach the backend's staging build.
    const notify = workflow("hosted-bake-notify");
    expect(notify.on.push.branches).toEqual(["main"]);
    expect(notify.on.push.paths).toContain("mcpjam-inspector/harness-bake.lock.json");
    expect(JSON.stringify(notify.jobs)).toContain("inspector_bake_moved");
  });

  it("deploys the webapp after the backend and the npm build, without waiting for the local harness gate or npm", () => {
    const { jobs } = workflow("release");
    const deploy = jobs["deploy-webapp"];
    expect(deploy.needs).toEqual(expect.arrayContaining(["preflight", "build-packages", "deploy-backend-prod"]));
    expect(deploy.needs).not.toContain("publish-packages");
    expect(deploy.needs).not.toContain("local-harness-contract");
    const gate = String(deploy.if).replace(/\s+/g, " ");
    expect(gate).toContain("!cancelled()");
    expect(gate).toContain("needs.build-packages.result == 'success'");
    expect(gate).toContain("( !fromJSON(inputs.deploy_backend_prod) || needs.deploy-backend-prod.result == 'success' )");
    // The satellites still follow the webapp, and the release page every deploy.
    expect(jobs["deploy-slack-app"].needs).toContain("deploy-webapp");
    expect(jobs.finalize.needs).toEqual(expect.arrayContaining(["deploy-webapp", "deploy-slack-app"]));
  });

  it("builds the Docker image while the gates run, and tags it only once npm has the version", () => {
    const { jobs } = workflow("release");
    expect(jobs["docker-release"].needs).toBe("preflight");
    expect(jobs["docker-release"].with.stage).toBe("build");
    expect(jobs["docker-publish"].needs).toEqual(["preflight", "publish-packages", "docker-release"]);
    expect(jobs["docker-publish"].with.stage).toBe("publish");
    expect(String(jobs["docker-publish"].if)).toContain("needs.publish-packages.result == 'success'");
    expect(jobs["announce-finish"].needs).toContain("docker-publish");
    const docker = workflow("docker-release");
    const push = docker.jobs.build.steps.find((step: any) => step.id === "push");
    expect(push.with.outputs).toContain("push-by-digest=true");
    expect(push.with.tags).toBeUndefined();
    expect(String(docker.jobs.build.if)).toContain("inputs.stage != 'publish'");
    expect(String(docker.jobs.publish.if)).toContain("inputs.stage != 'build'");
  });

  it("runs every Ubuntu release job on RELEASE_RUNNER when it is set", () => {
    const { jobs } = workflow("release");
    const ubuntu = Object.entries(jobs).filter(([, job]: [string, any]) => typeof job["runs-on"] === "string");
    expect(ubuntu.length).toBeGreaterThan(0);
    for (const [name, job] of ubuntu as Array<[string, any]>) {
      expect(job["runs-on"], name).toBe("${{ vars.RELEASE_RUNNER || 'ubuntu-latest' }}");
    }
  });
});

describe("starting a release", () => {
  it("pushes only a checked version commit, then starts Release on it", () => {
    const { jobs } = workflow("prepare-release");
    expect(Object.keys(workflow("prepare-release").on)).toEqual(["workflow_dispatch"]);
    const steps: any[] = jobs.version.steps;
    const run = steps.find((step) => step.name === "Version, check and push to main").run as string;
    const at = (needle: string) => run.indexOf(needle);
    // Versioned and checked before the push, which only fast-forwards. The
    // pack gate is not repeated here: the pin PR and Release both run it.
    expect(at("changeset version")).toBeGreaterThan(-1);
    expect(at("changeset version")).toBeLessThan(at("release-commit.mjs check HEAD^ HEAD"));
    expect(run).not.toMatch(/check-local-harness-release/);
    expect(at("release-commit.mjs check HEAD^ HEAD")).toBeLessThan(at("git push origin HEAD:refs/heads/main"));
    expect(run).not.toMatch(/--force/);
    // Pushed with the release App's token, the only bypass actor on main.
    const token = steps.find((step) => step.uses?.startsWith("actions/create-github-app-token"));
    expect(token).toBeDefined();
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout.with.token).toBe("${{ steps.app.outputs.token }}");
    // Then Release, on exactly the commit it pushed.
    const start = steps.find((step) => step.name === "Start Release");
    expect(start.with.script).toMatch(/workflow_id: "release\.yml"/);
    expect(start.env.SHA).toBe("${{ steps.push.outputs.sha }}");
  });

  it("builds and pins packs outside the release, so the release commit carries versions only", () => {
    const callers = readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) =>
        Object.values(parse(readFileSync(new URL(name, workflowsDir), "utf8"))?.jobs ?? {}).some(
          (job: any) => job?.uses === "./.github/workflows/local-harness-pack-pipeline.yml",
        ),
      )
      .sort();
    expect(callers).toEqual(["local-harness-pack-prebuild.yml"]);
    expect(JSON.stringify(workflow("prepare-release"))).not.toContain("apply-pins");
  });

  it("checks every commit that reaches main without a pull request", () => {
    const guard = workflow("main-push-guard");
    expect(guard.on.push.branches).toEqual(["main"]);
    const script = guard.jobs.check.steps.find((step: any) => step.id === "check").with.script as string;
    expect(script).toMatch(/listPullRequestsAssociatedWithCommit/);
    expect(script).toMatch(/checkVersionCommitBetween/);
  });
});

describe("pack prebuild", () => {
  it("prebuilds in the background and proposes the pins as one reviewed PR once every harness finishes", () => {
    const prebuild = workflow("local-harness-pack-prebuild");
    expect(prebuild.on.push.branches).toEqual(["main"]);
    // It stands down while signing needs a person (a build waiting for
    // approval would hold the harness's group, and the next run would queue
    // behind it), and never waits on another workflow's runs.
    expect(prebuild.jobs.prebuild.if).toBe("needs.harnesses.outputs.stand_down == 'false'");
    const guard = JSON.stringify(prebuild.jobs.harnesses);
    expect(guard).toContain("required_reviewers");
    expect(guard).not.toContain("prepare-release.yml");

    // All harnesses or none: no `if`, so a failed pipeline means no pin PR.
    const pinPr = prebuild.jobs["pin-pr"];
    expect(pinPr.needs).toBe("prebuild");
    expect(pinPr.if).toBeUndefined();
    expect(pinPr.concurrency).toEqual({ group: "local-harness-pack-pins", "cancel-in-progress": false });
    expect(pinPr.permissions).toEqual({ contents: "read", attestations: "read" });

    // Collect every pin, apply them in a clean install, gate exactly what the
    // PR pins, then open it through the shared bot script.
    const steps: any[] = pinPr.steps;
    const at = (test: (step: any) => boolean) => steps.findIndex(test);
    const checkout = at((step) => String(step.uses).startsWith("actions/checkout@"));
    const install = at((step) => /npm ci/.test(step.run ?? ""));
    const collect = at((step) => step.with?.pattern === "local-harness-pin-*");
    const apply = at((step) => /local-harness-publication\.mjs apply-pins/.test(step.run ?? ""));
    const gate = at((step) => /check-local-harness-release\.mjs --assets --verify-attestations/.test(step.run ?? ""));
    const newer = at((step) => step.id === "newer");
    const open = at((step) => step.name === "Open or refresh the pin PR");
    expect(steps[checkout].with["persist-credentials"]).toBe(false);
    expect(checkout).toBeLessThan(install);
    expect(install).toBeLessThan(apply);
    expect(collect).toBeGreaterThan(-1);
    expect(collect).toBeLessThan(apply);
    expect(apply).toBeLessThan(gate);
    expect(gate).toBeLessThan(newer);
    expect(newer).toBeLessThan(open);

    // A run from an older commit never replaces a newer commit's pins.
    expect(steps[newer].run).toMatch(/compare\/\$base\.\.\.\$GITHUB_SHA/);
    expect(steps[open].if).toBe("steps.newer.outputs.stand_down == 'false'");

    // Only the pin step holds the push token, and it stages only what
    // `apply-pins` writes, a new equivalence record included.
    expect(steps[open].env.GH_TOKEN).toBe("${{ secrets.RELEASE_PUSH_TOKEN }}");
    expect(steps.filter((step) => JSON.stringify(step).includes("RELEASE_PUSH_TOKEN"))).toHaveLength(1);
    const run: string = steps[open].run;
    expect(run).toMatch(/runtime-compat\.generated\.json/);
    expect(run).toMatch(/pack-inputs\.generated\.json/);
    expect(run).toMatch(/local-harness-pack-equivalence/);
    expect(run).not.toMatch(/git add (-u|-A|\.)/);
    expect(run).toMatch(/packs\.md/);
    expect(run).toContain('branch: "bot/local-harness-pack-pins"');
    expect(run).toMatch(/bash \.github\/scripts\/local-harness-bot-pr\.sh/);
  });

  it("prebuilds on a push that changes ANY declared pack input", async () => {
    // A missed input still gets built — by the nightly run, or by the release
    // itself — but later than it should. Codex's bootstrap lockfile was such a
    // miss once.
    const globToRegExp = (glob: string) =>
      new RegExp(
        `^${glob
          .split("**")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join(".*")}$`,
      );
    const filters = (workflow("local-harness-pack-prebuild").on.push.paths as string[]).map(globToRegExp);
    const { harnesses } = await computePackInputs();
    const declared = new Set<string>(["package-lock.json"]); // pack-dependency-closure
    for (const { inputs } of Object.values(harnesses)) {
      for (const key of Object.keys(inputs)) {
        // `recipe/*` are bytes emitted FROM declared sources, listed as well.
        if (key === "pack-dependency-closure" || key.startsWith("recipe/")) continue;
        declared.add(key);
      }
    }
    expect(
      [...declared].filter((path) => !filters.some((filter) => filter.test(path))),
      "add these to the push paths of local-harness-pack-prebuild.yml",
    ).toEqual([]);
  });
});

describe("pack release boundaries", () => {
  const runsAssetCheck = (name: string) =>
    Object.values(workflow(name).jobs)
      .flatMap((job: any) => job.steps ?? [])
      .some((step: any) => /check-local-harness-release\.mjs[^\n]*--assets/.test(step.run ?? ""));

  it("checks the published manifest before pinning a pack and before publishing a release", () => {
    for (const name of ["local-harness-pack-prebuild", "release"]) {
      expect(runsAssetCheck(name), name).toBe(true);
    }
  });

  it("verifies the pinned packs' build provenance wherever it checks their assets", () => {
    for (const name of ["local-harness-pack-prebuild", "release"]) {
      const steps = Object.values(workflow(name).jobs).flatMap((job: any) => job.steps ?? []);
      const gate = steps.find((step: any) => /check-local-harness-release\.mjs[^\n]*--assets/.test(step.run ?? ""));
      expect(gate.run, name).toMatch(/--verify-attestations/);
      expect(gate.env?.GH_TOKEN, name).toBeDefined();
    }
  });

  it("does not check published assets on a PR, where they cannot exist yet", () => {
    // Packs publish only from main, so a PR changing a pack input could never
    // pass this and had to merge with the required check red.
    expect(runsAssetCheck("lint")).toBe(false);
  });

  it("reports moved fingerprints on a PR instead of failing it", () => {
    // Merging is what publishes the pack a moved fingerprint describes; the
    // release gate is where a stale record blocks.
    const steps = workflow("lint").jobs.build.steps.filter((step: any) =>
      /check-local-harness-inputs\.mjs/.test(step.run ?? ""),
    );
    expect(steps.map((step: any) => step.run.trim())).toEqual([
      "node mcpjam-inspector/scripts/check-local-harness-inputs.mjs --advisory",
    ]);
    const unit = workflow("local-harness-conformance").jobs.unit.steps.filter((step: any) =>
      /check-local-harness-inputs\.mjs/.test(step.run ?? ""),
    );
    expect(unit.map((step: any) => step.run.trim())).toEqual([
      "node mcpjam-inspector/scripts/check-local-harness-inputs.mjs --advisory",
    ]);
  });

  it("never gives the vendor build job the signing environment or secret", () => {
    const { jobs } = workflow("local-harness-pack");
    expect(jobs.build.environment).toBeUndefined();
    expect(JSON.stringify(jobs.build)).not.toContain("secrets.");
    expect(jobs.sign.environment).toBe("local-harness-pack-release");
    expect(JSON.stringify(jobs.sign)).toContain("secrets.PROTECTED_LOCAL_HARNESS_PACK_SIGNING_KEY");
    expect(jobs.publish.needs).toContain("sign");
    expect(jobs.publish.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact")).with.name).toBe(
      "signed-local-harness-pack-${{ inputs.harness }}-${{ inputs.pack_version }}",
    );
  });

  it("generates the Codex bridge bundle before the Inspector layer that embeds it", () => {
    // The pack workflow runs only on main, so a PR never exercises it: the
    // first automatic run failed every leg because the layer bundler ran
    // without the Codex bundle it imports.
    const runs = workflow("local-harness-pack")
      .jobs.build.steps.map((step: any) => String(step.run ?? ""))
      .join("\n");
    const codex = runs.indexOf("bundle-codex-appserver-bridge.mjs");
    const layer = runs.indexOf("bundle-local-harness-layer.mjs");
    expect(layer).toBeGreaterThan(-1);
    expect(codex).toBeGreaterThan(-1);
    expect(codex).toBeLessThan(layer);
  });

  it("keeps every pack artifact to its own harness and version", () => {
    // Artifact names are run-wide, and the auto workflow builds every harness
    // in one run: an unscoped name collides (409) and an unscoped pattern
    // hands one harness's sign job the other's manifests.
    const { jobs } = workflow("local-harness-pack");
    const scope = "${{ inputs.harness }}";
    const version = "${{ inputs.pack_version }}";
    const artifactSteps = Object.values(jobs)
      .flatMap((job: any) => job.steps ?? [])
      .filter((step: any) => /^actions\/(upload|download)-artifact@/.test(step.uses ?? ""));
    expect(artifactSteps.length).toBeGreaterThanOrEqual(5);
    for (const step of artifactSteps) {
      const key = step.with.name ?? step.with.pattern;
      expect(key, JSON.stringify(step.with)).toContain(scope);
      expect(key, JSON.stringify(step.with)).toContain(version);
    }
  });

  it("ships a runtime contract proven by THIS commit's layer against every selected pack", () => {
    const { jobs } = workflow("release");
    // Evidence for the desired packs and, when the record permits one, the
    // previous ones — both from the conformance workflow, on the release commit.
    expect(jobs["local-harness-evidence"].uses).toBe("./.github/workflows/local-harness-conformance.yml");
    expect(jobs["local-harness-evidence-permitted"].uses).toBe("./.github/workflows/local-harness-conformance.yml");
    expect(jobs["local-harness-evidence-permitted"].with.harnesses).toContain("permitted_harnesses");
    const contract = jobs["local-harness-contract"];
    const runs = contract.steps.map((step: any) => step.run ?? "").join("\n");
    expect(runs).toMatch(/check-local-harness-release\.mjs[\s\S]*--evidence[\s\S]*--contract/);
    expect(contract.steps.some((step: any) => String(step.uses).startsWith("actions/attest-build-provenance"))).toBe(true);
    expect(contract.permissions).toMatchObject({ "id-token": "write", attestations: "write" });
    // No contract, no release: publishing requires it, and the published
    // release carries it.
    expect(jobs["publish-packages"].needs).toContain("local-harness-contract");
    expect(jobs["publish-packages"].if).toMatch(/needs\.local-harness-contract\.result == 'success'/);
    const finalizeFiles = jobs.finalize.steps
      .filter((step: any) => step.with?.files)
      .map((step: any) => step.with.files)
      .join("\n");
    expect(finalizeFiles).toContain("runtime-contract");
  });

  it("reuses evidence an earlier trusted run produced, and runs conformance itself only when there is none", () => {
    const { jobs } = workflow("release");
    const lookup = jobs["local-harness-evidence-lookup"];
    expect(lookup.needs).toBe("preflight");
    // `actions: write` only to cancel this commit's evidence run when it has
    // not started, so the release runs the gate instead of waiting on it.
    expect(lookup.permissions).toEqual({ contents: "read", actions: "write" });
    const find = lookup.steps.find((step: any) => step.id === "find");
    expect(find.with.script).toContain("findReleaseEvidence");
    expect(find.with.script).toContain("computeConformanceInputsDigest");
    expect(find.with.script).toContain("cancelWorkflowRun");
    for (const name of ["local-harness-evidence", "local-harness-evidence-permitted"]) {
      expect(jobs[name].needs, name).toContain("local-harness-evidence-lookup");
      expect(String(jobs[name].if), name).toContain("needs.local-harness-evidence-lookup.outputs.run_id == ''");
      expect(String(jobs[name].if), name).toContain("!cancelled()");
      expect(jobs[name].with.certified_only, name).toBe(true);
      // Off GitHub's five-job macOS cap, with a variable to go back.
      expect(jobs[name].with.macos_runner, name).toBe("${{ vars.RELEASE_MACOS_RUNNER || 'blacksmith-6vcpu-macos-latest' }}");
    }
    // Either way the same gate checks the records, and evidence made here is
    // marked for the next release to find.
    const contract = jobs["local-harness-contract"];
    const downloads = contract.steps.filter((step: any) => String(step.uses).startsWith("actions/download-artifact"));
    expect(downloads.map((step: any) => step.with["run-id"] ?? "")).toEqual([
      "",
      "${{ needs.local-harness-evidence-lookup.outputs.run_id }}",
    ]);
    const marker = contract.steps.find((step: any) => step.with?.name === "${{ needs.local-harness-evidence-lookup.outputs.name }}");
    expect(String(marker.if)).toContain("run_id == ''");
  });

  it("produces the release's evidence when a releasable commit lands, against the packs a release selects", () => {
    const evidence = workflow("local-harness-release-evidence");
    expect(evidence.on.push.branches).toEqual(["main"]);
    // A newer push must not cancel the run still going, or none ever finishes.
    expect(evidence.concurrency).toEqual({ group: "local-harness-release-evidence", "cancel-in-progress": false });
    const { jobs } = evidence;
    const plan = jobs.plan.steps.map((step: any) => `${step.run ?? ""}${step.with?.script ?? ""}`).join("\n");
    expect(plan).toContain("release-plan.mjs");
    expect(plan).toContain("local-harness-release-packs.mjs");
    expect(plan).toContain("findReleaseEvidence");
    for (const name of ["evidence", "evidence-permitted"]) {
      expect(jobs[name].uses, name).toBe("./.github/workflows/local-harness-conformance.yml");
      expect(jobs[name].with.certified_only, name).toBe(true);
    }
    // The marker means complete evidence: only after every selected pack passed.
    const record = String(jobs.record.if).replace(/\s+/g, " ");
    expect(record).toContain("needs.evidence.result == 'success'");
    expect(record).toContain("(needs.evidence-permitted.result == 'success' || needs.evidence-permitted.result == 'skipped')");
    expect(jobs.record.steps.find((step: any) => step.with?.name)?.with.name).toBe("${{ needs.plan.outputs.name }}");
    // The release reads its packs from the same script.
    const preflight = workflow("release").jobs.preflight.steps.find((step: any) => step.id === "local_harness_packs");
    expect(preflight.run).toContain("local-harness-release-packs.mjs");
  });

  it("translates the pack's x64 Node before a darwin-x64 session starts the bridge's clock", () => {
    const { jobs } = workflow("local-harness-conformance");
    for (const [name, harness] of [["scenarios", "claude-code"], ["codex-scenarios", "codex"]] as const) {
      const steps: any[] = jobs[name].steps;
      const translate = steps.findIndex((step) => step.name === "Translate the pack's x64 Node");
      expect(steps[translate]?.if, name).toBe("matrix.node_arch == 'x64' && runner.os == 'macOS'");
      expect(steps[translate].run, name).toBe(`arch -x86_64 "$RUNNER_TEMP/conformance/runtime/${harness}/bin/node" --version`);
      const packSteps = steps.flatMap((step, index) =>
        /scripts\/(prepare-published-harness-conformance|build-local-harness-pack)\.mjs/.test(step.run ?? "") ? [index] : [],
      );
      expect(packSteps, name).toHaveLength(2);
      expect(translate, name).toBeGreaterThan(Math.max(...packSteps));
      expect(translate, name).toBeLessThan(steps.findIndex((step) => /conformance\/run-[a-z-]+\.m?ts/.test(step.run ?? "")));
    }
  });

  it("builds the adapter once and hands it to every platform leg", () => {
    const { jobs } = workflow("local-harness-conformance");
    const unit = jobs.unit.steps.map((step: any) => step.run ?? "").join("\n");
    expect(unit).toMatch(/npm run build:sdk[\s\S]*npm run pretest[\s\S]*tar -czf/);
    const handOff = jobs.unit.steps.find((step: any) => String(step.with?.name ?? "").startsWith("conformance-adapter-build-"));
    for (const name of ["scenarios", "windows", "codex-scenarios", "runtime-scenarios"]) {
      const steps = jobs[name].steps;
      expect(steps.map((step: any) => step.run ?? "").join("\n"), name).not.toMatch(/npm run (build:sdk|pretest)/);
      const download = steps.find((step: any) => String(step.uses).startsWith("actions/download-artifact"));
      expect(download?.with.name, name).toBe(handOff.with.name);
      expect(jobs[name].needs, name).toContain("unit");
    }
  });

  it("plans a called run as a workflow_call, not as its caller's push", () => {
    const { plan } = workflow("local-harness-conformance").jobs;
    // A called run's github.workflow_ref names its caller: the push-started
    // evidence run, the pack prebuild, or a release.
    expect(plan.env.EVENT).toBe(
      "${{ contains(github.workflow_ref, '/.github/workflows/local-harness-conformance.yml@') && github.event_name || 'workflow_call' }}",
    );
    for (const step of plan.steps) {
      expect(JSON.stringify(step), step.name ?? step.id ?? step.uses).not.toContain("github.event_name");
    }
    expect(plan.steps.find((step: any) => step.name === "Fetch main's previous tip").if).toBe("env.EVENT == 'push'");
  });

  it("records conformance evidence in every leg, and plans PR legs against the pinned packs", () => {
    const { jobs } = workflow("local-harness-conformance");
    expect(jobs.plan.steps.some((step: any) => /plan-local-harness-conformance\.mjs/.test(step.run ?? ""))).toBe(true);
    for (const name of ["scenarios", "windows", "codex-scenarios", "runtime-scenarios"]) {
      const steps = jobs[name].steps;
      expect(steps.some((step: any) => /write-conformance-evidence\.mjs/.test(step.run ?? "")), name).toBe(true);
      expect(
        steps.some((step: any) => String(step.with?.name ?? "").startsWith("conformance-evidence-")),
        name,
      ).toBe(true);
      expect(jobs[name].needs, name).toContain("plan");
    }
  });

  it("attests what it signs, and adopts or finishes what already exists instead of refusing", () => {
    const { jobs, on } = workflow("local-harness-pack");
    expect(on.workflow_call.inputs.publish.default).toBe("always");
    expect(jobs.sign.permissions).toMatchObject({ "id-token": "write", attestations: "write" });
    const attest = jobs.sign.steps.find((step: any) => String(step.uses).startsWith("actions/attest-build-provenance"));
    expect(attest.with["subject-path"]).toMatch(/\.tar\.gz/);
    expect(attest.with["subject-path"]).toMatch(/\.manifest\.json/);
    expect(jobs.preflight.steps.some((step: any) => /local-harness-publication\.mjs existing/.test(step.run ?? ""))).toBe(true);
    expect(jobs.build.if).toBe("needs.preflight.outputs.state == 'none'");
    expect(jobs["finish-draft"].if).toMatch(/state == 'draft'/);
    // A build that reproduced the pinned bytes publishes nothing.
    expect(jobs.sign.if).toMatch(/equivalent != 'true'/);
    expect(jobs.publish.if).toMatch(/equivalent != 'true'/);
    // The build checks the install is the locked one; whether the inputs were
    // REVIEWED is the version PR's question.
    const builds = jobs.build.steps.map((step: any) => step.run ?? "").join("\n");
    expect(builds).toMatch(/check-local-harness-inputs\.mjs --drift/);
  });

  it("pipelines plan → pack → conformance → a pin handed to the release, and reports failures", () => {
    const { jobs } = workflow("local-harness-pack-pipeline");
    expect(jobs.plan.steps.some((step: any) => /local-harness-publication\.mjs plan/.test(step.run ?? ""))).toBe(true);
    expect(jobs.pack.uses).toBe("./.github/workflows/local-harness-pack.yml");
    expect(jobs.pack.with.publish).toBe("unless-equivalent");
    expect(jobs["candidate-conformance"].uses).toBe("./.github/workflows/local-harness-conformance.yml");
    expect(jobs["candidate-conformance"].with.candidate).toBe(true);
    expect(jobs.pin.if).toMatch(/candidate-conformance\.result == 'success'/);
    const pinRuns = jobs.pin.steps.map((step: any) => step.run ?? "").join("\n");
    expect(pinRuns).toMatch(/local-harness-publication\.mjs intent[\s\S]*--kind pin[\s\S]*--conformance/);
    // Every outcome hands the release one artifact per harness: up to date
    // (plan), an equivalence record, or a pin.
    for (const job of ["plan", "equivalence", "pin"]) {
      const upload = jobs[job].steps.find((step: any) => String(step.uses).startsWith("actions/upload-artifact@"));
      expect(upload?.with.name, job).toBe("local-harness-pin-${{ inputs.harness }}");
    }
    // The pipeline writes nothing to main and opens no PR of its own.
    const text = JSON.stringify(jobs);
    expect(text).not.toContain("local-harness-bot-pr.sh");
    expect(text).not.toContain("RELEASE_PUSH_TOKEN");
    // No install where provenance can be minted or pins are decided.
    for (const job of ["equivalence", "pin"]) {
      const runs = jobs[job].steps.map((step: any) => step.run ?? "").join("\n");
      expect(runs, job).not.toMatch(/npm (ci|install)/);
    }
    // The equivalence record is attested before it is handed over.
    const equivalence = jobs.equivalence.steps;
    expect(equivalence.some((step: any) => String(step.uses).startsWith("actions/attest-build-provenance"))).toBe(true);
    expect(jobs.report.if).toBe("always()");
    expect(jobs.report.permissions.issues).toBe("write");
  });
});
