import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  backfillTraceDestinationOperation,
  createTraceDestinationOperation,
  deleteTraceDestinationOperation,
  getTraceDestinationOperation,
  listTraceDestinationBackfillsOperation,
  listTraceDestinationsOperation,
  pauseTraceDestinationOperation,
  resumeTraceDestinationOperation,
  testTraceDestinationOperation,
  updateTraceDestinationOperation,
} from "@mcpjam/sdk/platform";
import { usageError, writeResult } from "../lib/output.js";
import {
  platformOptionsOf,
  runPlatformOperation as runPlatformCommand,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { getGlobalOptions } from "../lib/server-config.js";

/**
 * `mcpjam cloud trace-destinations` — where an organization's traces stream.
 *
 * A destination is a generic OTLP/HTTP target: an endpoint, the auth headers
 * the vendor expects, and any extra resource attributes it routes on. Every
 * eligible eval, scenario, swarm and shared-Playground turn is pushed to it
 * within about a minute, continuously, with no export step.
 *
 * ## Header values never come back
 *
 * Nothing here prints one, and nothing can: `list` and `show` return header
 * NAMES alongside the endpoint, sources, redaction setting and delivery
 * health. The values are written and used; they are never read back.
 *
 * ## How a header value gets in
 *
 * `--header-env` and `--header-file` are the forms to reach for. There is a
 * `--header "Name: value"` because scripting occasionally needs it, and it
 * carries the same caveat the secrets group states: a credential typed as an
 * argv token is written to shell history, is visible in `ps` and `/proc` to
 * every process on the machine for the life of the command, and lands in CI
 * logs that echo their commands.
 *
 *   mcpjam cloud trace-destinations create --org org_123 \
 *     --name "Coralogix" --endpoint https://ingress.eu2.coralogix.com:443 \
 *     --header-env "Authorization=CORALOGIX_BEARER" \
 *     --attr cx.application.name=mcpjam --attr cx.subsystem.name=evals
 *
 * ## Updating headers replaces all of them
 *
 * `update` sends the headers you name and only those, because that is what the
 * API does — a partial update would have to read the stored values to merge
 * them, and nothing may read them but the sender. Passing no header flag at
 * all leaves the stored set alone, which is the common case when editing
 * anything else, and `--clear-headers` removes them: three outcomes, because
 * "leave them" and "remove them" must not be spelled the same when one of them
 * sends a vendor's credentials to a new endpoint.
 *
 * ## Redaction is the default and stays that way unless you say otherwise
 *
 * Prompts, outputs, tool arguments and screenshots are redacted unless
 * `--include-content` is passed. It is a decision about whether customer
 * content leaves the platform, so there is no config file or env var that can
 * make it the default.
 */

/** Commander's repeatable-option collector. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

type HeaderOptions = {
  header?: string[];
  headerEnv?: string[];
  headerFile?: string[];
  clearHeaders?: boolean;
};

/** HTTP token, per RFC 7230. Mirrors the API's `headerNameSchema`. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * `Name=rest` → `[Name, rest]`, splitting on the FIRST separator only.
 *
 * THE MALFORMED ARGUMENT IS NEVER ECHOED. For `--header` the right-hand side
 * IS the credential, and a forgotten separator is the likeliest typo on the
 * flag — quoting the argument back would put the token in stderr, in CI logs
 * and in scrollback, which is exactly what this file promises it cannot do.
 * The flag name and the expected shape are enough to act on; the value the
 * user typed tells them nothing they do not already know.
 */
function splitOnFirst(
  raw: string,
  separator: string,
  flag: string
): [string, string] {
  const index = raw.indexOf(separator);
  // `< 0` and `=== 0` are different mistakes and get different sentences.
  // Folding them into `<= 0` told someone who wrote ": value" that their
  // argument had no separator, which is the one thing it did have, and made
  // the empty-name message below unreachable.
  if (index < 0) {
    throw usageError(
      `${flag} expects "Name${separator}value"; the argument had no "${separator}".`
    );
  }
  const name = raw.slice(0, index).trim();
  if (!name) {
    throw usageError(`${flag} has an empty name before the "${separator}".`);
  }
  return [name, raw.slice(index + separator.length)];
}

/**
 * Collect header values from every source the caller named.
 *
 * THREE OUTCOMES, and the distinction is the whole contract:
 *
 *   - `undefined` — no header flag was given. The API leaves the stored
 *     headers alone.
 *   - `{}` — `--clear-headers`. The API replaces the set with nothing, which
 *     is what you want before pointing a destination at a new endpoint that
 *     must not receive the old vendor's credentials.
 *   - a populated record — the new set, REPLACING the stored one.
 *
 * Accumulated on a null-prototype object: a header named `__proto__` passes
 * the HTTP-token rule, and assigning it on an object literal would set the
 * prototype instead of a key.
 *
 * A FILE IS READ VERBATIM apart from one trailing newline. Unlike a secret
 * value, an HTTP header cannot contain a newline at all: a stored one would
 * either be rejected by the backend's validator or, worse, be a header
 * injection. So the strip is unconditional here, and a file with an interior
 * newline is a usage error rather than something to pass along.
 */
export function resolveHeaders(
  options: HeaderOptions
): Record<string, string> | undefined {
  const headers: Record<string, string> = Object.create(null);
  const seen = new Map<string, string>();

  const named =
    (options.header?.length ?? 0) +
    (options.headerEnv?.length ?? 0) +
    (options.headerFile?.length ?? 0);
  if (options.clearHeaders) {
    if (named > 0) {
      throw usageError(
        "--clear-headers removes every header, so it cannot be combined with a header flag. Pass one or the other."
      );
    }
    return {};
  }

  const put = (name: string, value: string, flag: string) => {
    // Checked HERE and not only by the API: a name carrying a CRLF is a
    // header-injection attempt, and it should not travel the wire to be
    // refused as a malformed record key. Same pattern the route enforces.
    if (!HEADER_NAME_PATTERN.test(name)) {
      // The name is NOT echoed. `--header` splits on the first colon, so a
      // malformed argument can put credential material in the name position
      // (`--header "Bearer sk-live-…"` with the colon mistyped), and this
      // message goes to stderr and into CI logs. The rule is enough to act on
      // without quoting what failed it.
      throw usageError(
        `That ${flag} name is not an HTTP token. Use letters, digits and !#$%&'*+.^_\`|~- only.`
      );
    }
    const key = name.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw usageError(
        `Header "${name}" was given twice (already set by ${previous}). HTTP header names are case-insensitive.`
      );
    }
    // `\0` as well as CR/LF: all three terminate or split a header on some
    // stack, and none of them can appear in a legitimate credential.
    if (/[\r\n\0]/.test(value)) {
      throw usageError(
        `Header "${name}" contains a newline or a null byte. A header value cannot span lines.`
      );
    }
    if (value === "") {
      throw usageError(`The value for header "${name}" is empty.`);
    }
    seen.set(key, flag);
    headers[name] = value;
  };

  for (const raw of options.header ?? []) {
    const [name, value] = splitOnFirst(raw, ":", "--header");
    put(name, value.trim(), "--header");
  }

  for (const raw of options.headerEnv ?? []) {
    const [name, variable] = splitOnFirst(raw, "=", "--header-env");
    const value = process.env[variable.trim()];
    if (value === undefined || value === "") {
      throw usageError(
        `Environment variable "${variable.trim()}" is not set (or is empty).`
      );
    }
    put(name, value, "--header-env");
  }

  for (const raw of options.headerFile ?? []) {
    const [name, path] = splitOnFirst(raw, "=", "--header-file");
    const target = path.trim();
    let contents: string;
    try {
      contents =
        target === "-" ? readFileSync(0, "utf8") : readFileSync(target, "utf8");
    } catch (error) {
      throw usageError(
        target === "-"
          ? `Failed to read the value for header "${name}" from stdin.`
          : `Failed to read the value for header "${name}" from "${target}".`,
        { source: error instanceof Error ? error.message : String(error) }
      );
    }
    put(name, contents.replace(/\r?\n$/, ""), "--header-file");
  }

  return Object.keys(headers).length > 0 ? { ...headers } : undefined;
}

/** `--attr key=value`, repeatable. */
export function resolveAttributes(
  pairs: string[] | undefined
): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  // Null-prototype, and an OWN-property duplicate check: `key in out` on a
  // plain object reports `toString` and `constructor` as already present, so a
  // first attribute with either name would be refused as a duplicate.
  const out: Record<string, string> = Object.create(null);
  for (const raw of pairs) {
    const [key, value] = splitOnFirst(raw, "=", "--attr");
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw usageError(`Resource attribute "${key}" was given twice.`);
    }
    out[key] = value;
  }
  return { ...out };
}

const SOURCE_TYPES = ["eval", "scenario", "swarm", "direct"] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

export function resolveSourceTypes(
  values: string[] | undefined
): SourceType[] | undefined {
  if (!values || values.length === 0) return undefined;
  const out: SourceType[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!(SOURCE_TYPES as readonly string[]).includes(value)) {
      throw usageError(
        `--source expects one of ${SOURCE_TYPES.join(
          ", "
        )} (got ${JSON.stringify(raw)}).`
      );
    }
    if (!out.includes(value as SourceType)) out.push(value as SourceType);
  }
  return out;
}

type OrgOptions = PlatformOptions & { org: string };
type DestinationOptions = OrgOptions & { destination: string };

const ORG_FLAG_DESCRIPTION = "Organization ID, from `cloud organizations list`";

export function registerTraceDestinationsCommands(program: Command): void {
  const destinations = program
    .command("trace-destinations")
    .alias("traces")
    .description(
      "Stream an organization's traces to an OTLP/HTTP endpoint (Coralogix, Honeycomb, Grafana, a collector). Header values are write-only: no command prints one."
    );

  destinations
    .command("list")
    .description(
      "List the organization's destinations — endpoint, sources, redaction setting and delivery health. Header names only, never their values."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .action(async (options: OrgOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          listTraceDestinationsOperation.execute(
            { organization: options.org },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });

  destinations
    .command("show")
    .description(
      "Show one destination in full, including delivery health: the last HTTP status the vendor answered with, sessions and spans delivered, and how many are still queued."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption(
      "--destination <id>",
      "Destination ID, from `cloud trace-destinations list`"
    )
    .action(async (options: DestinationOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          getTraceDestinationOperation.execute(
            { organization: options.org, destination: options.destination },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });

  destinations
    .command("create")
    .description(
      "Create a destination and start streaming. Header values come from --header-env or --header-file; --header takes one inline for scripting."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--name <name>", "Human label for this destination.")
    .requiredOption(
      "--endpoint <url>",
      "The vendor's OTLP/HTTP intake, HTTPS only. `/v1/traces` is appended if the path does not already end there."
    )
    .option(
      "--header-env <Name=VAR>",
      "Repeatable: read a header's value from an environment variable. Preferred.",
      collect
    )
    .option(
      "--header-file <Name=path>",
      "Repeatable: read a header's value from a file (`-` reads stdin). One trailing newline is dropped — a header cannot span lines.",
      collect
    )
    .option(
      "--header <Name: value>",
      "Repeatable, SCRIPTING ONLY: an inline header value is written to your shell history and is visible in `ps` while the command runs.",
      collect
    )
    .option(
      "--attr <key=value>",
      "Repeatable: an extra OTel resource attribute (cx.application.name=mcpjam). `mcpjam.*` names are reserved by the exporter.",
      collect
    )
    .option(
      "--source <type>",
      "Repeatable: eval, scenario, swarm or direct. `direct` is Playground, and only sessions SHARED to the workspace are ever sent. Defaults to the server's default set.",
      collect
    )
    .option(
      "--include-content",
      "Send prompts, outputs, tool arguments and screenshots. OFF by default, and off is the safe reading — this decides whether customer content leaves the platform."
    )
    .option(
      "--project <id>",
      "Repeatable: restrict to these projects. Omit for every project in the organization, present and future.",
      collect
    )
    .option(
      "--compression <mode>",
      "gzip or none. gzip is optional in OTLP/HTTP and some intakes reject it."
    )
    .option(
      "--preset <id>",
      "Vendor preset id this was created from (coralogix, honeycomb, …). Labelling only."
    )
    .option("--disabled", "Create it without starting the stream.")
    .action(
      async (
        options: OrgOptions &
          HeaderOptions & {
            name: string;
            endpoint: string;
            attr?: string[];
            source?: string[];
            includeContent?: boolean;
            project?: string[];
            compression?: string;
            preset?: string;
            disabled?: boolean;
          },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        const headers = resolveHeaders(options);
        const resourceAttributes = resolveAttributes(options.attr);
        const sourceTypes = resolveSourceTypes(options.source);
        if (
          options.compression !== undefined &&
          options.compression !== "gzip" &&
          options.compression !== "none"
        ) {
          throw usageError("--compression expects gzip or none.");
        }

        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            createTraceDestinationOperation.execute(
              {
                organization: options.org,
                name: options.name,
                endpointUrl: options.endpoint,
                ...(headers ? { headers } : {}),
                ...(resourceAttributes ? { resourceAttributes } : {}),
                ...(sourceTypes ? { sourceTypes } : {}),
                ...(options.includeContent ? { includeContent: true } : {}),
                ...(options.project ? { projectIds: options.project } : {}),
                ...(options.compression
                  ? { compression: options.compression as "gzip" | "none" }
                  : {}),
                ...(options.preset ? { preset: options.preset } : {}),
                ...(options.disabled ? { enabled: false } : {}),
              },
              { client, signal }
            ),
          { cloudScope: { kind: "organization", organization: options.org } }
        );
        writeResult(result, globalOptions.format);
      }
    );

  destinations
    .command("update")
    .description(
      "Edit a destination. Any header flag REPLACES the whole header set; passing none leaves the stored headers alone."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--destination <id>", "Destination ID")
    .option("--name <name>", "New label.")
    .option("--endpoint <url>", "New OTLP/HTTP intake, HTTPS only.")
    .option(
      "--header-env <Name=VAR>",
      "Repeatable: read a header's value from an environment variable. Preferred.",
      collect
    )
    .option(
      "--header-file <Name=path>",
      "Repeatable: read a header's value from a file (`-` reads stdin).",
      collect
    )
    .option(
      "--header <Name: value>",
      "Repeatable, SCRIPTING ONLY: written to your shell history and visible in `ps`.",
      collect
    )
    .option(
      "--clear-headers",
      "Remove every stored header. Reach for this before pointing a destination at a new endpoint that must not receive the old vendor's credentials — omitting the header flags LEAVES them, which is not the same thing."
    )
    .option(
      "--attr <key=value>",
      "Repeatable: REPLACES the resource attributes.",
      collect
    )
    .option("--source <type>", "Repeatable: REPLACES the source list.", collect)
    .option("--include-content", "Start sending content. Audited.")
    .option("--no-include-content", "Stop sending content; redact again.")
    .option(
      "--project <id>",
      "Repeatable: REPLACES the project allowlist.",
      collect
    )
    .option(
      "--all-projects",
      "Stream every project in the organization. The explicit way back — an empty --project list would mean a destination that matches nothing."
    )
    .option("--compression <mode>", "gzip or none.")
    .option("--enable", "Start streaming.")
    .option("--disable", "Stop streaming, keeping the configuration.")
    .action(
      async (
        options: OrgOptions &
          HeaderOptions & {
            destination: string;
            name?: string;
            endpoint?: string;
            attr?: string[];
            source?: string[];
            includeContent?: boolean;
            project?: string[];
            allProjects?: boolean;
            compression?: string;
            enable?: boolean;
            disable?: boolean;
          },
        command
      ) => {
        const globalOptions = getGlobalOptions(command);
        if (options.enable && options.disable) {
          throw usageError("Pass --enable or --disable, not both.");
        }
        if (options.allProjects && options.project) {
          throw usageError(
            "Pass --all-projects or --project, not both — they are two answers to the same question."
          );
        }
        if (
          options.compression !== undefined &&
          options.compression !== "gzip" &&
          options.compression !== "none"
        ) {
          throw usageError("--compression expects gzip or none.");
        }

        const headers = resolveHeaders(options);
        const resourceAttributes = resolveAttributes(options.attr);
        const sourceTypes = resolveSourceTypes(options.source);
        const enabled = options.enable
          ? true
          : options.disable
          ? false
          : undefined;

        const patch = {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.endpoint !== undefined
            ? { endpointUrl: options.endpoint }
            : {}),
          ...(headers ? { headers } : {}),
          ...(resourceAttributes ? { resourceAttributes } : {}),
          ...(sourceTypes ? { sourceTypes } : {}),
          // Commander's `--no-include-content` sets this to false, so the
          // tri-state survives: absent leaves it, true starts sending content,
          // false redacts again.
          ...(options.includeContent !== undefined
            ? { includeContent: options.includeContent }
            : {}),
          ...(options.project ? { projectIds: options.project } : {}),
          ...(options.allProjects ? { allProjects: true } : {}),
          ...(options.compression
            ? { compression: options.compression as "gzip" | "none" }
            : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw usageError("Nothing to update — pass at least one field.");
        }

        const result = await runPlatformCommand(
          platformOptionsOf(command),
          globalOptions.timeout,
          ({ client, signal }) =>
            updateTraceDestinationOperation.execute(
              {
                organization: options.org,
                destination: options.destination,
                ...patch,
              },
              { client, signal }
            ),
          { cloudScope: { kind: "organization", organization: options.org } }
        );
        writeResult(result, globalOptions.format);
      }
    );

  destinations
    .command("rm")
    .description(
      "Delete a destination. Streaming stops and anything queued is discarded — but traces ALREADY DELIVERED stay in the vendor's system, and nothing here can retract them."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--destination <id>", "Destination ID")
    .action(async (options: DestinationOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          deleteTraceDestinationOperation.execute(
            { organization: options.org, destination: options.destination },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });

  destinations
    .command("test")
    .description(
      "Send one synthetic span, to prove the endpoint and credentials work. Returns as soon as the send is SCHEDULED — read the outcome from `show` a moment later."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--destination <id>", "Destination ID")
    .action(async (options: DestinationOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          testTraceDestinationOperation.execute(
            { organization: options.org, destination: options.destination },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });

  destinations
    .command("pause")
    .description(
      "Stop delivering without deleting. NOTHING IS QUEUED while paused: the window becomes a gap, not a backlog, and only `backfill` can fill it."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--destination <id>", "Destination ID")
    .action(async (options: DestinationOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          pauseTraceDestinationOperation.execute(
            { organization: options.org, destination: options.destination },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });

  destinations
    .command("resume")
    .description(
      "Start delivering again. Fix what caused an automatic pause first — `show` reports the reason — or it will pause again. Reports `pausedSince` so the gap can be sized."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--destination <id>", "Destination ID")
    .action(async (options: DestinationOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          resumeTraceDestinationOperation.execute(
            { organization: options.org, destination: options.destination },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });

  destinations
    .command("backfill")
    .description(
      "Replay a window of history — for the gap a pause left, or to seed a new destination. Queues every eligible session in the window, so a wide window is a lot of vendor ingest."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--destination <id>", "Destination ID")
    .requiredOption(
      "--days <n>",
      "How far back to replay. 1 to 30.",
      (value: string) => {
        // `Number`, not `parseInt`: parseInt("1.5") and parseInt("1foo") both
        // yield 1, so a typo would silently become a one-day replay.
        const days = Number(value.trim());
        if (!Number.isInteger(days) || days < 1 || days > 30) {
          throw usageError("--days expects a whole number between 1 and 30.");
        }
        return days;
      }
    )
    .action(async (options: DestinationOptions & { days: number }, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          backfillTraceDestinationOperation.execute(
            {
              organization: options.org,
              destination: options.destination,
              days: options.days,
            },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });

  destinations
    .command("backfills")
    .description(
      "The 20 most recent backfills for a destination, newest first, with how many sessions each scanned and queued."
    )
    .requiredOption("--org <id>", ORG_FLAG_DESCRIPTION)
    .requiredOption("--destination <id>", "Destination ID")
    .action(async (options: DestinationOptions, command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await runPlatformCommand(
        platformOptionsOf(command),
        globalOptions.timeout,
        ({ client, signal }) =>
          listTraceDestinationBackfillsOperation.execute(
            { organization: options.org, destination: options.destination },
            { client, signal }
          ),
        { cloudScope: { kind: "organization", organization: options.org } }
      );
      writeResult(result, globalOptions.format);
    });
}
