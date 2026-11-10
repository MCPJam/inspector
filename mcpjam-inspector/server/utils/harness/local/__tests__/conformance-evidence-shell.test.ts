import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; run?: string };
const file = new URL("../../../../../../.github/workflows/local-harness-conformance.yml", import.meta.url);
const workflow = parse(readFileSync(file, "utf8")) as { jobs: Record<string, { steps: Step[] }> };

describe("conformance evidence shell arguments", () => {
  for (const job of ["scenarios", "windows", "codex-scenarios"]) {
    it.each(["", "1.0.6"])(`${job} records source or published evidence (%s)`, (version) => {
      const script = workflow.jobs[job].steps.find((step) => step.name === "Record conformance evidence")?.run;
      if (!script) throw new Error(`Missing evidence step for ${job}`);
      const output = execFileSync("/bin/bash", ["-c", 'node() { printf "%s\\n" "$@"; };\n' + script.replace(/\$\{\{ matrix.platform_key \}\}/g, "darwin-arm64")], {
        encoding: "utf8",
        env: { ...process.env, PACK_VERSION: version, CONFORMANCE_ROOT: "/fixture with spaces" },
      }).trim().split("\n");
      expect(output).toContain("/fixture with spaces/evidence");
      expect(output.includes("--published")).toBe(Boolean(version));
      if (version) expect(output).toContain("/fixture with spaces/published-conformance-input.json");
    });
  }
});
