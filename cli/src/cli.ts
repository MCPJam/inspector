#!/usr/bin/env node

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { dirname, resolve } from "path";
import { spawnPromise } from "spawn-rx";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_BANNER = `
███╗   ███╗ ██████╗██████╗     ██╗ █████╗ ███╗   ███╗
████╗ ████║██╔════╝██╔══██╗    ██║██╔══██╗████╗ ████║
██╔████╔██║██║     ██████╔╝    ██║███████║██╔████╔██║
██║╚██╔╝██║██║     ██╔═══╝██   ██║██╔══██║██║╚██╔╝██║
██║ ╚═╝ ██║╚██████╗██║    ╚█████╔╝██║  ██║██║ ╚═╝ ██║
╚═╝     ╚═╝ ╚═════╝╚═╝     ╚════╝ ╚═╝  ╚═╝╚═╝     ╚═╝                                                    
`;

type Args = {
  command: string;
  args: string[];
  envArgs: Record<string, string>;
  cli: boolean;
  serverConfigs?: Record<string, ServerConfig>;
};

type CliOptions = {
  e?: Record<string, string>;
  config?: string;
  server?: string;
  cli?: boolean;
};

type ServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

function handleError(error: unknown): never {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = "Unknown error";
  }

  console.error("\x1b[31m%s\x1b[0m", "❌ Error:", message); // Red color

  process.exit(1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms, true));
}

async function runWebClient(args: Args): Promise<void> {
  const inspectorServerPath = resolve(
    __dirname,
    "../../",
    "server",
    "build",
    "index.js",
  );

  // Path to the client entry point
  const inspectorClientPath = resolve(
    __dirname,
    "../../",
    "client",
    "bin",
    "client.js",
  );

  const CLIENT_PORT: string = process.env.CLIENT_PORT ?? "6274";
  const SERVER_PORT: string = process.env.SERVER_PORT ?? "6277";

  // Clear console and display banner
  console.clear();
  console.log("\x1b[36m%s\x1b[0m", MCP_BANNER); // Cyan color
  console.log("\x1b[33m%s\x1b[0m", "🚀 Launching MCP Inspector...\n"); // Yellow color

  const abort = new AbortController();
  let cancelled: boolean = false;
  process.on("SIGINT", () => {
    cancelled = true;
    abort.abort();
    console.log("\n\x1b[31m%s\x1b[0m", "⚠️  Shutting down MCP Inspector..."); // Red color
  });

  let server: ReturnType<typeof spawnPromise>;
  let serverOk: unknown;

  try {
    server = spawnPromise(
      "node",
      [
        inspectorServerPath,
        ...(args.command ? [`--env`, args.command] : []),
        ...(args.args ? [`--args=${args.args.join(" ")}`] : []),
      ],
      {
        env: {
          ...process.env,
          PORT: SERVER_PORT,
          MCP_ENV_VARS: JSON.stringify(args.envArgs),
          MCP_SERVER_CONFIGS: args.serverConfigs
            ? JSON.stringify(args.serverConfigs)
            : undefined,
        },
        signal: abort.signal,
        echoOutput: true,
      },
    );

    // Make sure server started before starting client
    serverOk = await Promise.race([server, delay(2 * 1000)]);
  } catch (error) {
    console.log("\x1b[31m%s\x1b[0m", "❌ Server initialization failed"); // Red color
  }

  if (serverOk) {
    try {
      console.log("\x1b[32m%s\x1b[0m", "✅ Server initialized successfully"); // Green color
      console.log("\x1b[33m%s\x1b[0m", "🖥️  Starting client interface...");

      await spawnPromise("node", [inspectorClientPath], {
        env: {
          ...process.env,
          PORT: CLIENT_PORT,
          MCP_AUTO_OPEN_ENABLED: process.env.MCP_AUTO_OPEN_ENABLED ?? "true",
        },
        signal: abort.signal,
        echoOutput: true,
      });
    } catch (e) {
      if (!cancelled || process.env.DEBUG) throw e;
    }
  }
}

async function runCli(args: Args): Promise<void> {
  const projectRoot = resolve(__dirname, "..");
  const cliPath = resolve(projectRoot, "build", "index.js");

  const abort = new AbortController();

  let cancelled = false;

  process.on("SIGINT", () => {
    cancelled = true;
    abort.abort();
  });

  try {
    await spawnPromise("node", [cliPath, args.command, ...args.args], {
      env: { ...process.env, ...args.envArgs },
      signal: abort.signal,
      echoOutput: true,
    });
  } catch (e) {
    if (!cancelled || process.env.DEBUG) {
      throw e;
    }
  }
}

function loadConfigFile(configPath: string, serverName: string): ServerConfig {
  try {
    const resolvedConfigPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(process.cwd(), configPath);

    if (!fs.existsSync(resolvedConfigPath)) {
      throw new Error(`Config file not found: ${resolvedConfigPath}`);
    }

    const configContent = fs.readFileSync(resolvedConfigPath, "utf8");
    const parsedConfig = JSON.parse(configContent);

    if (!parsedConfig.mcpServers || !parsedConfig.mcpServers[serverName]) {
      const availableServers = Object.keys(parsedConfig.mcpServers || {}).join(
        ", ",
      );
      throw new Error(
        `Server '${serverName}' not found in config file. Available servers: ${availableServers}`,
      );
    }

    const serverConfig = parsedConfig.mcpServers[serverName];

    return serverConfig;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${err.message}`);
    }

    throw err;
  }
}

function loadAllServersFromConfig(
  configPath: string,
): Record<string, ServerConfig> {
  try {
    const resolvedConfigPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(process.cwd(), configPath);

    if (!fs.existsSync(resolvedConfigPath)) {
      throw new Error(`Config file not found: ${resolvedConfigPath}`);
    }

    const configContent = fs.readFileSync(resolvedConfigPath, "utf8");
    const parsedConfig = JSON.parse(configContent);

    if (!parsedConfig.mcpServers) {
      throw new Error("No 'mcpServers' section found in config file");
    }

    return parsedConfig.mcpServers;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${err.message}`);
    }

    throw err;
  }
}

function parseKeyValuePair(
  value: string,
  previous: Record<string, string> = {},
): Record<string, string> {
  const parts = value.split("=");
  const key = parts[0];
  const val = parts.slice(1).join("=");

  if (val === undefined || val === "") {
    throw new Error(
      `Invalid parameter format: ${value}. Use key=value format.`,
    );
  }

  return { ...previous, [key as string]: val };
}

function parseArgs(): Args {
  const program = new Command();

  const argSeparatorIndex = process.argv.indexOf("--");
  let preArgs = process.argv;
  let postArgs: string[] = [];

  if (argSeparatorIndex !== -1) {
    preArgs = process.argv.slice(0, argSeparatorIndex);
    postArgs = process.argv.slice(argSeparatorIndex + 1);
  }

  program
    .name("inspector-bin")
    .allowExcessArguments()
    .allowUnknownOption()
    .option(
      "-e <env>",
      "environment variables in KEY=VALUE format",
      parseKeyValuePair,
      {},
    )
    .option("--config <path>", "config file path")
    .option("--server <n>", "server name from config file")
    .option("--cli", "enable CLI mode");

  // Parse only the arguments before --
  program.parse(preArgs);

  const options = program.opts() as CliOptions;
  const remainingArgs = program.args;

  // Add back any arguments that came after --
  const finalArgs = [...remainingArgs, ...postArgs];

  // Validate server option
  if (!options.config && options.server) {
    throw new Error("--server option requires --config to be specified.");
  }

  // If config file is specified
  if (options.config) {
    if (options.server) {
      // Single server mode: load specific server from config
      const config = loadConfigFile(options.config, options.server);

      return {
        command: config.command,
        args: [...(config.args || []), ...finalArgs],
        envArgs: { ...(config.env || {}), ...(options.e || {}) },
        cli: options.cli || false,
      };
    } else {
      // Multiple servers mode: load all servers from config
      const serverConfigs = loadAllServersFromConfig(options.config);

      return {
        command: "", // No single command in multi-server mode
        args: finalArgs,
        envArgs: options.e || {},
        cli: options.cli || false,
        serverConfigs,
      };
    }
  }

  // Otherwise use command line arguments
  const command = finalArgs[0] || "";
  const args = finalArgs.slice(1);

  return {
    command,
    args,
    envArgs: options.e || {},
    cli: options.cli || false,
  };
}

async function main(): Promise<void> {
  process.on("uncaughtException", (error) => {
    handleError(error);
  });

  try {
    const args = parseArgs();

    if (args.cli) {
      runCli(args);
    } else {
      await runWebClient(args);
    }
  } catch (error) {
    handleError(error);
  }
}

main();
