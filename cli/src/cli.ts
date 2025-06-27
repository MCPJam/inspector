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
  allServers?: ServerConfig[];
};

type CliOptions = {
  e?: Record<string, string>;
  config?: string;
  server?: string;
  cli?: boolean;
};

type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  name?: string;
  // URL-based server properties
  url?: string;
  type?: "sse" | "streamable-http";
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

  // Prepare environment variables
  let mcpEnvVars = args.envArgs;
  let serverArgs: string[] = [];

  // If we have multiple servers from config, pass them to the client
  if (args.allServers && args.allServers.length > 1) {
    console.log(`\x1b[32m%s\x1b[0m`, `✅ Loading ${args.allServers.length} servers from config file`);
    
    // Convert all servers back to the config file format for the client to import
    const configForClient = {
      mcpServers: {} as Record<string, any>
    };
    
    for (const server of args.allServers) {
      const serverConfig: any = {};
      
      // Handle command-based servers (stdio)
      if (server.command) {
        serverConfig.command = server.command;
        
        if (server.args && server.args.length > 0) {
          serverConfig.args = server.args;
        }
        
        if (server.env && Object.keys(server.env).length > 0) {
          serverConfig.env = server.env;
        }
      }
      
      // Handle URL-based servers (SSE/HTTP)
      if (server.url) {
        serverConfig.url = server.url;
        
        if (server.type) {
          serverConfig.type = server.type;
        }
      }
      
      configForClient.mcpServers[server.name || 'unnamed-server'] = serverConfig;
    }
    
    // Pass the config file content to the client via environment variable
    mcpEnvVars = {
      ...mcpEnvVars,
      MCP_AUTO_IMPORT_CONFIG: JSON.stringify(configForClient),
    };
    
    console.log(`\x1b[36m%s\x1b[0m`, "📋 Config will be automatically imported in the client");
  } else {
    // Single server mode (existing behavior)
    serverArgs = [
      ...(args.command ? [`--env`, args.command] : []),
      ...(args.args ? [`--args=${args.args.join(" ")}`] : []),
    ];
  }

  try {
    server = spawnPromise(
      "node",
      [inspectorServerPath, ...serverArgs],
      {
        env: {
          ...process.env,
          PORT: SERVER_PORT,
          MCP_ENV_VARS: JSON.stringify(mcpEnvVars),
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
      console.log(
        "\x1b[36m%s\x1b[0m",
        `🌐 Opening browser at http://127.0.0.1:${CLIENT_PORT}`,
      );

      if (process.env.MCP_AUTO_OPEN_ENABLED !== "false") {
        // Note: We need to import 'open' if we want to auto-open browser
        // import open from "open";
        // open(`http://127.0.0.1:${CLIENT_PORT}`);
      }

      console.log("\x1b[33m%s\x1b[0m", "🖥️  Starting client interface...");

      await spawnPromise("node", [inspectorClientPath], {
        env: { ...process.env, PORT: CLIENT_PORT },
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

function loadConfigFile(configPath: string, serverName?: string): ServerConfig | ServerConfig[] {
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
      throw new Error("Config file must contain 'mcpServers' property");
    }

    // If no specific server requested, return all servers
    if (!serverName) {
      const servers: ServerConfig[] = [];
      for (const [name, config] of Object.entries(parsedConfig.mcpServers)) {
        servers.push({
          ...(config as ServerConfig),
          name,
        });
      }
      
      if (servers.length === 0) {
        throw new Error("No servers found in config file");
      }
      
      return servers;
    }

    // Load specific server (existing behavior)
    if (!parsedConfig.mcpServers[serverName]) {
      const availableServers = Object.keys(parsedConfig.mcpServers || {}).join(
        ", ",
      );
      throw new Error(
        `Server '${serverName}' not found in config file. Available servers: ${availableServers}`,
      );
    }

    const serverConfig = parsedConfig.mcpServers[serverName];
    return { ...serverConfig, name: serverName };
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
    .option("--server <n>", "server name from config file (optional when using --config)")
    .option("--cli", "enable CLI mode");

  // Parse only the arguments before --
  program.parse(preArgs);

  const options = program.opts() as CliOptions;
  const remainingArgs = program.args;

  // Add back any arguments that came after --
  const finalArgs = [...remainingArgs, ...postArgs];

  // Remove the old validation that required both config and server
  // Now --config can be used alone to load all servers
  if (options.server && !options.config) {
    throw new Error(
      "--server can only be used together with --config. Use --config to specify the config file.",
    );
  }

  // If config file is specified, load and use the options from the file
  if (options.config) {
    const configResult = loadConfigFile(options.config, options.server);

    // Handle single server (when --server is specified)
    if (!Array.isArray(configResult)) {
      return {
        command: configResult.command || "",
        args: [...(configResult.args || []), ...finalArgs],
        envArgs: { ...(configResult.env || {}), ...(options.e || {}) },
        cli: options.cli || false,
      };
    }

    // Handle multiple servers (when no --server is specified)
    // For now, we'll use the first server as the primary command
    // but store all servers for potential future multi-server support
    const primaryServer = configResult[0];
    if (!primaryServer) {
      throw new Error("No servers found in config file");
    }
    
    return {
      command: primaryServer.command || "",
      args: [...(primaryServer.args || []), ...finalArgs],
      envArgs: { ...(primaryServer.env || {}), ...(options.e || {}) },
      cli: options.cli || false,
      allServers: configResult,
    };
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
