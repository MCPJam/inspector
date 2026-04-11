import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runServerDoctor,
  type RunServerDoctorInput,
  type ServerDoctorResult,
} from "@mcpjam/sdk";
import { getCliRpcLogEvents, type CliRpcLogCollector } from "./rpc-logs";
import { redactSensitiveValue } from "./redaction";
import { operationalError } from "./output";
import {
  normalizeCliError,
  toStructuredError,
  type OutputFormat,
} from "./output";

type StructuredCommandError = ReturnType<typeof toStructuredError>["error"];

export interface DebugArtifactEnvelope<TTarget = unknown> {
  schemaVersion: 1;
  generatedAt: string;
  command: {
    name: string;
    input: unknown;
  };
  target: TTarget;
  outcome: {
    status: "success" | "error";
    result?: unknown;
    error?: StructuredCommandError;
  };
  snapshot: ServerDoctorResult<TTarget> | null;
  snapshotError?: StructuredCommandError;
  _rpcLogs?: ReturnType<typeof getCliRpcLogEvents>;
}

export type DebugArtifactOutcome =
  | {
      status: "success";
      result: unknown;
    }
  | {
      status: "error";
      error: unknown;
      result?: unknown;
    };

export interface CommandDebugArtifactOptions<TTarget = unknown> {
  outputPath?: string;
  format: OutputFormat;
  commandName: string;
  commandInput: unknown;
  target: TTarget;
  outcome: DebugArtifactOutcome;
  snapshot?: {
    input: RunServerDoctorInput<TTarget>;
    collector?: CliRpcLogCollector;
  };
  collectors?: Array<CliRpcLogCollector | undefined>;
}

export async function writeCommandDebugArtifact<TTarget = unknown>(
  options: CommandDebugArtifactOptions<TTarget>,
  dependencies: {
    runDoctor?: typeof runServerDoctor;
  } = {},
): Promise<string | undefined> {
  if (!options.outputPath) {
    return undefined;
  }

  const snapshotResult = options.snapshot
    ? await collectDoctorSnapshot(options.snapshot, dependencies)
    : { snapshot: null, snapshotError: null };

  const payload = buildDebugArtifactEnvelope({
    commandName: options.commandName,
    commandInput: options.commandInput,
    target: options.target,
    outcome: options.outcome,
    snapshot: snapshotResult.snapshot,
    snapshotError: snapshotResult.snapshotError,
    collectors: [
      ...(options.collectors ?? []),
      options.snapshot?.collector,
    ],
  });
  const artifactPath = await writeDebugArtifact(options.outputPath, payload);

  if (options.format === "human") {
    process.stderr.write(`Debug artifact: ${artifactPath}\n`);
  }

  return artifactPath;
}

export function buildDebugArtifactEnvelope<TTarget = unknown>(options: {
  commandName: string;
  commandInput: unknown;
  target: TTarget;
  outcome: DebugArtifactOutcome;
  snapshot: ServerDoctorResult<TTarget> | null;
  snapshotError?: StructuredCommandError | null;
  collectors?: Array<CliRpcLogCollector | undefined>;
}): DebugArtifactEnvelope<TTarget> {
  const payload: DebugArtifactEnvelope<TTarget> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: {
      name: options.commandName,
      input: options.commandInput,
    },
    target: options.target,
    outcome: buildOutcome(options.outcome),
    snapshot: options.snapshot,
  };

  if (options.snapshotError) {
    payload.snapshotError = options.snapshotError;
  }

  const rpcLogs = getCliRpcLogEvents(options.collectors ?? []);
  if (rpcLogs.length > 0) {
    payload._rpcLogs = rpcLogs;
  }

  return redactSensitiveValue(payload) as DebugArtifactEnvelope<TTarget>;
}

export function buildCommandArtifactError(
  code: string,
  message: string,
  details?: unknown,
): StructuredCommandError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

export async function writeDebugArtifact(
  outputPath: string,
  payload: unknown,
): Promise<string> {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  const redactedPayload = redactSensitiveValue(payload);

  try {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      `${JSON.stringify(redactedPayload, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    throw operationalError(
      `Failed to write debug artifact to "${resolvedPath}".`,
      {
        source: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return resolvedPath;
}

async function collectDoctorSnapshot<TTarget = unknown>(options: {
  input: RunServerDoctorInput<TTarget>;
  collector?: CliRpcLogCollector;
}, dependencies: {
  runDoctor?: typeof runServerDoctor;
} = {}): Promise<{
  snapshot: ServerDoctorResult<TTarget> | null;
  snapshotError: StructuredCommandError | null;
}> {
  try {
    const runDoctor = dependencies.runDoctor ?? runServerDoctor;
    return {
      snapshot: await runDoctor({
        ...options.input,
        rpcLogger: options.collector?.rpcLogger,
      }),
      snapshotError: null,
    };
  } catch (error) {
    return {
      snapshot: null,
      snapshotError: normalizeArtifactError(error),
    };
  }
}

function buildOutcome(outcome: DebugArtifactOutcome) {
  if (outcome.status === "success") {
    return {
      status: "success" as const,
      result: outcome.result,
    };
  }

  return {
    status: "error" as const,
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
    error: normalizeArtifactError(outcome.error),
  };
}

function normalizeArtifactError(error: unknown): StructuredCommandError {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return error as StructuredCommandError;
  }

  return toStructuredError(normalizeCliError(error)).error;
}
