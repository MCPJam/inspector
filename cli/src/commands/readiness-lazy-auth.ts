import {
  DIRECTORY_FEATURE_CLAIMS,
  LAZY_AUTH_PROBE_LIMITS,
  type DirectoryFeatureClaim,
  type DirectoryLazyAuthProbeConfig,
} from "@mcpjam/sdk";
import { Command } from "commander";
import { usageError } from "../lib/output.js";
import { HostedStartOptions, ReadinessCheckOptions } from "./readiness.js";

/** Commander collector for a repeatable option. */
export function collectRepeated(
  value: string,
  previous: string[] = [],
): string[] {
  return [...previous, value];
}

/**
 * `--claim` values, validated. An unknown claim is a usage error rather than
 * a silent drop: `lazy-auth` read as "nothing claimed" would report the
 * feature `not-evaluated` while the submitter believes they claimed it.
 */
export function parseFeatureClaims(
  values: readonly string[] | undefined,
): DirectoryFeatureClaim[] | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.length > LAZY_AUTH_PROBE_LIMITS.maxFeatureClaims) {
    throw usageError(
      `At most ${LAZY_AUTH_PROBE_LIMITS.maxFeatureClaims} --claim values may be given.`,
    );
  }
  const claims = new Set<DirectoryFeatureClaim>();
  for (const raw of values) {
    const value = raw.trim();
    if (!(DIRECTORY_FEATURE_CLAIMS as readonly string[]).includes(value)) {
      throw usageError(
        `Unknown --claim "${raw}". One of: ${DIRECTORY_FEATURE_CLAIMS.join(", ")}.`,
      );
    }
    claims.add(value as DirectoryFeatureClaim);
  }
  return [...claims].sort();
}

export function readProbeToolName(
  value: string | undefined,
  flag: string,
): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (!name) throw usageError(`${flag} needs a tool name.`);
  if (name.length > LAZY_AUTH_PROBE_LIMITS.toolNameMaxChars) {
    throw usageError(
      `${flag} is longer than ${LAZY_AUTH_PROBE_LIMITS.toolNameMaxChars} characters.`,
    );
  }
  return name;
}

/**
 * The lazy-auth probe config, armed by its OWN flags.
 *
 * Not behind an `--intrusive` switch, and the reason is the gate model rather
 * than convenience. The SDK's intrusive gate exists for probes that register
 * clients and spend grants; this probe does neither. It sends no credentials
 * at all — not even the `--access-token` this command was given — calls only
 * tools annotated `readOnlyHint: true`, and makes at most two calls. The SDK
 * gives it its own gate (`enabled: true`, literally), and naming a tool here
 * is the explicit opt-in that gate asks for.
 */
export function lazyAuthProbeFromOptions(
  options: Pick<
    ReadinessCheckOptions,
    "lazyAuthProbe" | "lazyAuthTool" | "lazyAuthPublicTool"
  >,
): DirectoryLazyAuthProbeConfig | undefined {
  const toolName = readProbeToolName(options.lazyAuthTool, "--lazy-auth-tool");
  const publicToolName = readProbeToolName(
    options.lazyAuthPublicTool,
    "--lazy-auth-public-tool",
  );
  if (!options.lazyAuthProbe && !toolName && !publicToolName) return undefined;
  if (toolName !== undefined && toolName === publicToolName) {
    throw usageError(
      "--lazy-auth-tool and --lazy-auth-public-tool name the same tool; one call cannot be both the public and the protected one.",
    );
  }
  return {
    enabled: true,
    ...(toolName ? { toolName } : {}),
    ...(publicToolName ? { publicToolName } : {}),
  };
}

/** The flags both local checks share for lazy authentication and claims. */
export function addLazyAuthOptions(command: Command): Command {
  return command
    .option(
      "--claim <feature>",
      `Declare a feature the server offers, so the report shows it as claimed: ${DIRECTORY_FEATURE_CLAIMS.join(
        " | ",
      )}. Repeat to claim several.`,
      collectRepeated,
    )
    .option(
      "--lazy-auth-probe",
      "Verify lazy authentication: call one public and one protected read-only tool WITHOUT credentials (at most two calls, readOnlyHint tools only), picked by their securitySchemes",
    )
    .option(
      "--lazy-auth-tool <name>",
      "The protected read-only tool the lazy-auth probe calls without credentials. Implies --lazy-auth-probe.",
    )
    .option(
      "--lazy-auth-public-tool <name>",
      "The public read-only tool the lazy-auth probe calls without credentials. Implies --lazy-auth-probe.",
    );
}

/**
 * The lazy-auth and claim fields of a hosted start, present only when given.
 *
 * Absent rather than `undefined` so a start that asked for neither sends the
 * same body it sent before these existed. The hosted probe is the same
 * credential-free probe as the local one: the platform never sends the saved
 * server's credential on its calls.
 */
export function hostedLazyAuthFields(options: HostedStartOptions): {
  lazyAuthProbe?: { enabled: true; toolName?: string; publicToolName?: string };
  claimedFeatures?: DirectoryFeatureClaim[];
} {
  const probe = lazyAuthProbeFromOptions(options);
  const claims = parseFeatureClaims(options.claim);
  return {
    ...(probe
      ? {
          lazyAuthProbe: {
            enabled: true as const,
            ...(probe.toolName ? { toolName: probe.toolName } : {}),
            ...(probe.publicToolName
              ? { publicToolName: probe.publicToolName }
              : {}),
          },
        }
      : {}),
    ...(claims ? { claimedFeatures: claims } : {}),
  };
}
