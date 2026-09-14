/**
 * Types for the dev-environment guard's pure half.
 *
 * The script is plain ESM so it runs under a bare Node from an npm `pre*` hook
 * with no TypeScript in the loop, so it carries a hand-written declaration
 * rather than being compiled -- the same arrangement as
 * `check-local-harness-release.d.mts`. Only the decision function and the task
 * list are exported; `src/check-dev-env.test.ts` imports them to pin the
 * severity table, which is the part of this guard that must not drift.
 */

/** A single environment problem, with a copy-pasteable remediation. */
export interface DevEnvFinding {
  /** Stable identifier; assert on this rather than on wording. */
  code:
    | "node-too-new"
    | "node-too-old"
    | "dmg-addon-unusable"
    | "build-output-missing"
    | "port-busy"
    | "env-development-missing";
  message: string;
  /** Shell-ready fix, possibly multi-line. */
  fix: string;
}

export type DevEnvTask =
  "dev" | "electron-dev" | "electron-package" | "electron-make";

export interface DevEnvInput {
  task: DevEnvTask | string;
  /** `process.version` spelling or bare "26.3.0"; both are accepted. */
  nodeVersion: string;
  /** `process.platform` spelling. */
  platform: string;
  /** Contents of `.nvmrc`. Absent means no upper bound is enforced. */
  nvmrcVersion?: string;
  /** package.json `engines.node`, e.g. ">=22.0.0". */
  enginesNodeRange?: string;
  allowUnsupportedNode?: boolean;
  skipDmgCheck?: boolean;
  dmgAddons?: Array<{ name: string; ok: boolean; reason?: string }>;
  buildOutputs?: Array<{ label: string; exists: boolean }>;
  portInUse?: boolean;
  envDevelopmentMissing?: boolean;
}

export declare const TASKS: DevEnvTask[];

/**
 * Classify gathered environment facts into blocking errors and warnings.
 * Pure -- no file system, no network, no `process`. Throws on an unknown task.
 */
export declare function evaluateDevEnv(input: DevEnvInput): {
  errors: DevEnvFinding[];
  warnings: DevEnvFinding[];
};
