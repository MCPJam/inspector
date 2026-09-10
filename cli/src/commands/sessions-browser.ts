import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  driveChatSessionBrowserOperation,
  observeChatSessionBrowserOperation,
  type DriveChatSessionBrowserInput,
  type ObserveChatSessionBrowserInput,
  type PlatformSessionBrowserInput,
} from "@mcpjam/sdk/platform";
import {
  addProjectOption,
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { fetchArtifactBytes } from "../lib/download-screenshot.js";
import { usageError } from "../lib/output.js";

export type BrowserOptions = PlatformOptions & {
  session?: string;
  project?: string;
  browser?: boolean;
  browserMode?: string;
  browserOrigins?: string[];
  browserTools?: string[];
  browserProfile?: string;
  commandId?: string;
  idempotencyKey?: string;
  input?: string;
  verb?: string;
  target?: string;
  value?: string;
  expectedState?: string;
  mode?: string;
  download?: string;
};
export function browserInput(
  options: BrowserOptions
): PlatformSessionBrowserInput | undefined {
  const requested =
    options.browser ||
    options.browserMode ||
    options.browserOrigins ||
    options.browserTools ||
    options.browserProfile;
  if (!requested) return undefined;
  if ((options.browserOrigins || options.browserTools) && !options.browserMode)
    throw usageError(
      "--browser-origins and --browser-tools require --browser-mode"
    );
  if (
    options.browserMode &&
    !["allow_all", "read_only", "allowlist"].includes(options.browserMode)
  )
    throw usageError(
      "--browser-mode must be allow_all, read_only, or allowlist"
    );
  return {
    ...(options.browserMode
      ? {
          policy: {
            mode: options.browserMode as
              | "allow_all"
              | "read_only"
              | "allowlist",
            ...(options.browserOrigins
              ? { originAllowlist: options.browserOrigins }
              : {}),
            ...(options.browserTools
              ? { toolAllowlist: options.browserTools }
              : {}),
          },
        }
      : {}),
    ...(options.browserProfile ? { profileId: options.browserProfile } : {}),
  };
}
export function addBrowserFlags(command: Command): Command {
  return command
    .option("--browser", "Attach the session browser for this turn")
    .option(
      "--browser-mode <mode>",
      "Initial browser grant: allow_all, read_only, or allowlist"
    )
    .option("--browser-origins <origins...>", "Allowed HTTP(S) origins")
    .option(
      "--browser-tools <tools...>",
      "Allowed browser_* or webmcp:<name> tools"
    )
    .option("--browser-profile <profileId>", "Initial saved browser profile");
}
function json(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw usageError("Expected valid JSON");
  }
}
export function registerSessionsBrowserCommands(sessions: Command): void {
  const browser = sessions
    .command("browser")
    .description(
      "Drive the same hosted browser as an API Playground session. Uses metered desktop time."
    );
  const common = (command: Command, required = true) =>
    (required
      ? command.requiredOption("--session <id>", "Public chat session ID")
      : command.option("--session <id>", "Existing public chat session ID")
    ).option("--command-id <id>", "Stable command ID for retries");
  bindOperation(
    addBrowserFlags(
      addProjectOption(common(browser.command("open"), false))
    ).option(
      "--idempotency-key <key>",
      "Stable key when creating a new session"
    ),
    driveChatSessionBrowserOperation,
    (o: BrowserOptions): DriveChatSessionBrowserInput => ({
      op: "open",
      sessionId: o.session,
      project: o.project,
      ...browserInput({ ...o, browser: true }),
      idempotencyKey: o.idempotencyKey ?? randomUUID(),
    }),
    { defaultTimeoutMs: 360_000 }
  );
  bindOperation(
    common(browser.command("navigate <url>")),
    driveChatSessionBrowserOperation,
    (o: BrowserOptions, url): DriveChatSessionBrowserInput => ({
      op: "navigate",
      sessionId: o.session,
      url,
      commandId: o.commandId ?? randomUUID(),
    }),
    { defaultTimeoutMs: 360_000 }
  );
  bindOperation(
    common(browser.command("act"))
      .requiredOption(
        "--verb <verb>",
        "click, type, press, scroll, hover, drag, select, or dialog/tab action"
      )
      .option("--target <json>", "Target ref, selector, or coordinates")
      .option("--value <text>", "Action value")
      .option("--expected-state <token>", "Observation state token"),
    driveChatSessionBrowserOperation,
    (o: BrowserOptions): DriveChatSessionBrowserInput => ({
      op: "act",
      sessionId: o.session,
      commandId: o.commandId ?? randomUUID(),
      command: {
        verb: o.verb,
        target: json(o.target),
        value: o.value,
        expectedState: o.expectedState,
      },
    }),
    { defaultTimeoutMs: 360_000 }
  );
  bindOperation(
    common(browser.command("invoke <toolKey>")).requiredOption(
      "--input <json>",
      "Page tool input"
    ),
    driveChatSessionBrowserOperation,
    (o: BrowserOptions, toolKey): DriveChatSessionBrowserInput => ({
      op: "invoke",
      sessionId: o.session,
      toolKey,
      input: json(o.input),
      commandId: o.commandId ?? randomUUID(),
    }),
    { defaultTimeoutMs: 360_000 }
  );
  bindOperation(
    common(browser.command("note <text>")),
    driveChatSessionBrowserOperation,
    (o: BrowserOptions, text): DriveChatSessionBrowserInput => ({
      op: "note",
      sessionId: o.session,
      text,
      commandId: o.commandId ?? randomUUID(),
    })
  );
  bindOperation(
    common(browser.command("close")),
    driveChatSessionBrowserOperation,
    (o: BrowserOptions): DriveChatSessionBrowserInput => ({
      op: "close",
      sessionId: o.session,
    })
  );
  for (const op of ["observe", "trace", "artifact"] as const) {
    const command = common(browser.command(op))
      .option("--mode <mode>", "Observation mode (default screenshot)")
      .option("--download <dir>", "Download screenshot to this directory");
    bindOperation(
      command,
      {
        ...observeChatSessionBrowserOperation,
        execute: async (
          input: ObserveChatSessionBrowserInput & { download?: string },
          context
        ) => {
          const { download, ...wire } = input;
          const result = await observeChatSessionBrowserOperation.execute(
            wire,
            context
          );
          if (!download) return result;
          if (op === "trace")
            throw usageError("Use observe or artifact with --download");
          const artifact =
            op === "artifact"
              ? result
              : await context.client.chatSessionBrowser(
                  wire.sessionId,
                  "artifact",
                  { commandId: wire.commandId },
                  { signal: context.signal }
                );
          if (!("url" in artifact) || typeof artifact.url !== "string")
            throw usageError("No screenshot is available for this command");
          const bytes = await fetchArtifactBytes(artifact.url, 30_000);
          const extension =
            bytes[0] === 255 && bytes[1] === 216 ? "jpg" : "png";
          const dir = resolve(download);
          await mkdir(dir, { recursive: true });
          const path = resolve(
            dir,
            `${(wire.commandId ?? "screenshot").replace(
              /[^A-Za-z0-9_.-]/g,
              "_"
            )}.${extension}`
          );
          await writeFile(path, bytes);
          return { ...result, savedTo: path };
        },
      },
      (
        o: BrowserOptions
      ): ObserveChatSessionBrowserInput & { download?: string } => {
        if (op === "artifact" && !o.commandId)
          throw usageError("artifact requires --command-id");
        return {
          op,
          sessionId: o.session!,
          commandId:
            o.commandId ?? (op === "observe" ? randomUUID() : undefined),
          mode: o.mode as ObserveChatSessionBrowserInput["mode"],
          download: o.download,
        };
      },
      { defaultTimeoutMs: 360_000 }
    );
  }
}
