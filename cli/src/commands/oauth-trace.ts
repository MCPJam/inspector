/**
 * HP-44 — `mcpjam oauth trace` — the golden-trace parity harness CLI.
 *
 * Bolted onto the existing `mcpjam oauth conformance` story (HP-39) rather than
 * built beside it: `capture` runs the same `OAuthConformanceTest` the conformance
 * command runs and turns its result into a trace, so there is one code path
 * driving the emulator and one place where its wire behavior is recorded.
 *
 * Four verbs:
 *   capture     run our emulator against a server and write a candidate trace
 *   ingest-har  turn a proxy capture of a REAL host into a golden trace
 *   diff        compare two traces field by field — the acceptance oracle
 *   to-profile  project a trace onto HostConfigOAuthProfileV1
 *
 * `diff` exits non-zero on any difference or incomparable finding, so it works as
 * a CI gate for HP-43 enforcement and HP-38 drift detection. Gaps do NOT fail by
 * default — an unobserved leg is not evidence of divergence — but `--fail-on-gap`
 * makes them fail for callers who need full coverage.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  OAuthConformanceTest,
  captureEmulatorTrace,
  captureHarTrace,
  diffGoldenTraces,
  findObservationDrift,
  formatHarIngestReportHuman,
  formatTraceDiffHuman,
  formatTraceSummaryHuman,
  traceToOAuthProfile,
  type GoldenTrace,
  type OAuthConformanceConfig,
  type TraceDiffMode,
  type TraceOAuthImplementation,
  type TraceScenario,
} from "@mcpjam/sdk";
import type { Command } from "commander";

import { cliError, setProcessExitCode, usageError, writeResult } from "../lib/output.js";
import { resolveOAuthOutputFormat, type OAuthOutputFormat } from "../lib/oauth-output.js";

function traceFormat(command: Command): OAuthOutputFormat {
  const opts = command.optsWithGlobals() as { format?: string };
  return resolveOAuthOutputFormat(opts.format, process.stdout.isTTY);
}

function readJsonFile(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw cliError(
      "VALIDATION_ERROR",
      `${label} could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw cliError(
      "VALIDATION_ERROR",
      `${label} at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function readTrace(path: string, label: string): GoldenTrace {
  const parsed = readJsonFile(path, label) as GoldenTrace;
  if (parsed?.traceVersion !== 1) {
    throw cliError(
      "VALIDATION_ERROR",
      `${label} at ${path} is not a golden trace (expected traceVersion 1, got ${String(parsed?.traceVersion)}).`,
    );
  }

  // Structural check BEFORE the drift check, which walks `wire` and `observations`
  // and would otherwise throw a raw TypeError at the user for a file that is
  // merely malformed — the one class of bad input that escaped the CliError
  // contract every other malformed input here gets.
  const missing: string[] = [];
  if (!Array.isArray(parsed.wire)) missing.push("wire (must be an array)");
  if (!parsed.observations || typeof parsed.observations !== "object") {
    missing.push("observations (must be an object)");
  }
  if (!parsed.scenario || typeof parsed.scenario !== "object") {
    missing.push("scenario (must be an object)");
  }
  if (missing.length > 0) {
    throw cliError(
      "VALIDATION_ERROR",
      `${label} at ${path} declares traceVersion 1 but is not a structurally valid golden trace — missing or malformed: ${missing.join(", ")}.`,
    );
  }

  // A hand-edited trace whose summary no longer follows from its own wire would
  // skew every downstream verdict, so it is rejected rather than trusted.
  const drift = findObservationDrift(parsed);
  if (drift.length > 0) {
    throw cliError(
      "VALIDATION_ERROR",
      `${label} at ${path} has observations that do not follow from its own wire (it may have been hand-edited): ${drift.join("; ")}`,
    );
  }

  return parsed;
}

/**
 * The scenario block, which GATES any later diff.
 *
 * Required rather than inferred: guessing a server's capabilities would let two
 * genuinely-incomparable captures be compared, and the differ would then report a
 * conformant client as broken.
 */
export function readScenario(path: string): TraceScenario {
  const scenario = readJsonFile(path, "Scenario file") as TraceScenario;
  if (!scenario?.scenarioId || !scenario?.mcpServerUrl || !scenario?.capabilities) {
    throw usageError(
      `Scenario file at ${path} must define scenarioId, mcpServerUrl and capabilities. The capabilities block gates every diff: a client that omits \`resource\` when PRM discovery fails is behaving correctly, and without knowing whether the server published a PRM document the harness cannot tell that from a bug.`,
    );
  }
  return scenario;
}

/**
 * Parse `--oauth-implementation pkg@version:resolvedFrom`.
 *
 * Five of six source-verified clients inherit OAuth from a dependency, so a trace
 * stamped only with the host version goes stale on a dependency bump with no
 * visible signal. The resolved version must come from a lockfile, not a manifest
 * range.
 */
export function parseOAuthImplementation(
  value: string | undefined,
): TraceOAuthImplementation | undefined {
  if (!value) return undefined;
  if (value === "first-party") return { kind: "first-party" };

  const match = /^(.+)@([^@:]+):(.+)$/.exec(value);
  if (!match) {
    throw usageError(
      `--oauth-implementation must be "first-party" or "<package>@<resolved-version>:<resolved-from>" (e.g. "rmcp@2.2.0:Cargo.lock"). Got: ${value}`,
    );
  }
  return {
    kind: "dependency",
    package: match[1],
    version: match[2],
    resolvedFrom: match[3],
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerOAuthTraceCommands(oauth: Command): void {
  const trace = oauth
    .command("trace")
    .description(
      "Golden-trace parity harness: capture real host OAuth handshakes and diff emulator dances against them (HP-44)",
    );

  trace
    .command("capture")
    .description(
      "Run the MCPJam emulator against a server and write a candidate golden trace",
    )
    .requiredOption("--server-url <url>", "MCP server URL")
    .requiredOption(
      "--scenario <path>",
      "Path to a JSON scenario file describing the test server's capabilities (gates any later diff)",
    )
    .requiredOption("--out <path>", "Write the trace JSON to <path>")
    .option("--host-id <id>", "Catalog host id whose behavior is being emulated", "mcpjam")
    .option(
      "--protocol-version <version>",
      "MCP protocol version for the flow",
      "2025-11-25",
    )
    .option(
      "--registration-strategy <strategy>",
      "dcr | cimd | preregistered",
      "dcr",
    )
    .option("--redirect-url <url>", "OAuth redirect URL to use for the flow")
    .option("--scopes <scopes>", "Space-separated scope string")
    .option("--client-id <id>", "Pre-registered OAuth client ID")
    .option(
      "--client-secret <secret>",
      "Pre-registered OAuth client secret. Prefer the MCPJAM_OAUTH_CLIENT_SECRET environment variable — an argv value is visible to any process that can read the process list",
    )
    .option(
      "--captured-at <date>",
      "ISO calendar date (YYYY-MM-DD) to stamp on the trace. Defaults to today.",
    )
    .option("--host-version <version>", "Version of the emulated host build")
    .option(
      "--oauth-implementation <spec>",
      '"first-party" or "<package>@<resolved-version>:<resolved-from>", e.g. "rmcp@2.2.0:Cargo.lock"',
    )
    .option("--state-machine <name>", "State machine that ran, e.g. debug-oauth-2025-11-25")
    .action(async (options, command) => {
      const format = traceFormat(command);
      const scenario = readScenario(options.scenario as string);

      // An argv secret is readable by any process that can list processes, and on
      // a shared or CI box that is everyone. The environment variable is the
      // lesser evil and is preferred when both are present, so a caller migrating
      // to it does not have to remove the flag in the same change.
      const clientSecret =
        process.env.MCPJAM_OAUTH_CLIENT_SECRET || (options.clientSecret as string | undefined);
      if (options.clientSecret && process.env.MCPJAM_OAUTH_CLIENT_SECRET) {
        process.stderr.write(
          "warning: both --client-secret and MCPJAM_OAUTH_CLIENT_SECRET are set; using the environment variable.\n",
        );
      }

      // A secret is only ever carried on the preregistered client block, which
      // exists only when a client id was given. Silently dropping it would let a
      // run fail at the token leg for a reason the caller cannot see from here.
      if (clientSecret && !options.clientId) {
        throw usageError(
          "A client secret requires --client-id (secret supplied via --client-secret or MCPJAM_OAUTH_CLIENT_SECRET).",
        );
      }

      const config: OAuthConformanceConfig = {
        serverUrl: options.serverUrl as string,
        protocolVersion: options.protocolVersion as OAuthConformanceConfig["protocolVersion"],
        registrationStrategy:
          options.registrationStrategy as OAuthConformanceConfig["registrationStrategy"],
        auth: { mode: "interactive" },
        ...(options.redirectUrl ? { redirectUrl: options.redirectUrl as string } : {}),
        ...(options.scopes ? { scopes: options.scopes as string } : {}),
        ...(options.clientId
          ? {
              client: {
                preregistered: {
                  clientId: options.clientId as string,
                  ...(clientSecret ? { clientSecret } : {}),
                },
              },
            }
          : {}),
      };

      const result = await new OAuthConformanceTest(config).run();

      const captured = captureEmulatorTrace({
        result,
        hostId: options.hostId as string,
        scenario,
        capturedAt: (options.capturedAt as string | undefined) ?? todayIso(),
        capturedAtExact: new Date().toISOString(),
        ...(options.hostVersion ? { hostVersion: options.hostVersion as string } : {}),
        ...(parseOAuthImplementation(options.oauthImplementation as string | undefined)
          ? {
              oauthImplementation: parseOAuthImplementation(
                options.oauthImplementation as string,
              )!,
            }
          : {}),
        ...(options.stateMachine ? { stateMachine: options.stateMachine as string } : {}),
      });

      writeFileSync(options.out as string, `${JSON.stringify(captured, null, 2)}\n`, "utf8");

      writeResult(
        {
          traceId: captured.traceId,
          path: options.out as string,
          exchanges: captured.wire.length,
          legOrder: captured.observations.legOrder,
          conformancePassed: result.passed,
          summary: formatTraceSummaryHuman(captured),
        },
        format,
      );

      // A capture that did not complete the flow still produces a usable trace
      // (its unreached legs become `not-observed` gaps), but the caller should
      // know the run failed.
      if (!result.passed) setProcessExitCode(1);
    });

  trace
    .command("ingest-har")
    .description(
      "Turn a proxy capture (HAR 1.2) of a REAL host handshake into a golden trace",
    )
    .requiredOption("--har <path>", "Path to the HAR file")
    .requiredOption(
      "--scenario <path>",
      "Path to a JSON scenario file describing the server the host was pointed at",
    )
    .requiredOption("--host-id <id>", "Catalog host id that was captured")
    .requiredOption("--out <path>", "Write the trace JSON to <path>")
    .option("--captured-at <date>", "ISO calendar date. Defaults to the HAR's first entry.")
    .option("--host-version <version>", "Version of the host build that was captured")
    .option(
      "--oauth-implementation <spec>",
      '"first-party" or "<package>@<resolved-version>:<resolved-from>". Strongly recommended: without it the trace cannot detect a dependency bump.',
    )
    .option("--surface <surface>", "Which surface of a multi-surface client, e.g. web | desktop | cli")
    .option("--build <build>", "Which build, e.g. official | oss")
    .option("--operator <name>", "Who ran the capture")
    .option(
      "--note <text>",
      "Caveat a reviewer needs. Repeat for several.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .action(async (options, command) => {
      const format = traceFormat(command);
      const scenario = readScenario(options.scenario as string);
      const har = readJsonFile(options.har as string, "HAR file");

      const { trace: ingested, report } = captureHarTrace({
        har,
        hostId: options.hostId as string,
        scenario,
        ...(options.capturedAt ? { capturedAt: options.capturedAt as string } : {}),
        ...(options.hostVersion ? { hostVersion: options.hostVersion as string } : {}),
        ...(parseOAuthImplementation(options.oauthImplementation as string | undefined)
          ? {
              oauthImplementation: parseOAuthImplementation(
                options.oauthImplementation as string,
              )!,
            }
          : {}),
        ...(options.surface ? { surface: options.surface as string } : {}),
        ...(options.build ? { build: options.build as string } : {}),
        ...(options.operator ? { operator: options.operator as string } : {}),
        ...((options.note as string[]).length > 0
          ? { notes: options.note as string[] }
          : {}),
      });

      writeFileSync(options.out as string, `${JSON.stringify(ingested, null, 2)}\n`, "utf8");

      if (format === "human") {
        process.stdout.write(`${formatTraceSummaryHuman(ingested)}\n\n`);
        process.stdout.write(`${formatHarIngestReportHuman(report)}\n`);
        return;
      }

      writeResult(
        { traceId: ingested.traceId, path: options.out as string, report },
        format,
      );
    });

  trace
    .command("diff")
    .description(
      "Diff a candidate trace against a golden one, field by field. Exits 1 on any difference.",
    )
    .requiredOption("--golden <path>", "Golden trace (recorded from the real host)")
    .requiredOption("--candidate <path>", "Candidate trace (produced by our emulator)")
    .option(
      "--mode <mode>",
      "parity (emulator vs real host) or drift (same subject, two dates). Defaults to auto-detect.",
    )
    .option(
      "--fail-on-gap",
      "Also exit 1 when any field was not comparable. Off by default: an unobserved leg is not evidence of divergence.",
    )
    .option(
      "--ignore-header <name>",
      "Exclude a header from value comparison. Repeat for several.",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .action(async (options, command) => {
      const format = traceFormat(command);
      const golden = readTrace(options.golden as string, "Golden trace");
      const candidate = readTrace(options.candidate as string, "Candidate trace");

      const rawMode = options.mode as string | undefined;
      if (rawMode && rawMode !== "parity" && rawMode !== "drift") {
        throw usageError(`--mode must be "parity" or "drift". Got: ${rawMode}`);
      }
      const mode: TraceDiffMode | undefined = rawMode as TraceDiffMode | undefined;

      const result = diffGoldenTraces(golden, candidate, {
        ...(mode ? { mode } : {}),
        ignoreHeaders: options.ignoreHeader as string[],
      });

      if (format === "human") {
        process.stdout.write(`${formatTraceDiffHuman(result)}\n`);
      } else {
        writeResult(result, format);
      }

      if (!result.parity) {
        setProcessExitCode(1);
      } else if (options.failOnGap && result.counts.gap > 0) {
        setProcessExitCode(1);
      }
    });

  trace
    .command("to-profile")
    .description(
      "Project a trace onto HostConfigOAuthProfileV1, with a citation and a capture date on every field",
    )
    .requiredOption("--trace <path>", "Path to the golden trace")
    .option(
      "--trace-path <path>",
      "Repo-relative path to cite as the source. Defaults to --trace.",
    )
    .option(
      "--contrast-trace <path>",
      "A second trace of the same host against a server advertising a DIFFERENT protocol version. The only way protocolVersionPinning can be settled for the initialize body.",
    )
    .option("--out <path>", "Write the profile JSON to <path> instead of stdout")
    .action(async (options, command) => {
      const format = traceFormat(command);
      const source = readTrace(options.trace as string, "Trace");
      const contrast = options.contrastTrace
        ? readTrace(options.contrastTrace as string, "Contrast trace")
        : undefined;

      const profile = traceToOAuthProfile(source, {
        tracePath: (options.tracePath as string | undefined) ?? (options.trace as string),
        ...(contrast ? { contrastTrace: contrast } : {}),
      });

      if (options.out) {
        writeFileSync(options.out as string, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
        // `--out` writes the profile INSTEAD of printing it, so only a reference to
        // the artifact goes to stdout. Echoing the profile as well would contaminate
        // anything piping stdout into a second tool, and `capture` / `ingest-har`
        // already hold to the same contract.
        writeResult({ traceId: source.traceId, path: options.out as string }, format);
        return;
      }

      writeResult(profile, format);
    });
}
