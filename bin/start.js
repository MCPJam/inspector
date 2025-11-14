#!/usr/bin/env node

import { resolve, dirname } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import open from "open";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_BANNER = `
███╗   ███╗ ██████╗██████╗     ██╗ █████╗ ███╗   ███╗
████╗ ████║██╔════╝██╔══██╗    ██║██╔══██╗████╗ ████║
██╔████╔██║██║     ██████╔╝    ██║███████║██╔████╔██║
██║╚██╔╝██║██║     ██╔═══╝██   ██║██╔══██║██║╚██╔╝██║
██║ ╚═╝ ██║╚██████╗██║    ╚█████╔╝██║  ██║██║ ╚═╝ ██║
╚═╝     ╚═╝ ╚═════╝╚═╝     ╚════╝ ╚═╝  ╚═╝╚═╝     ╚═╝                                                    
`;

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

// Utility functions for beautiful output
function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, colors.green);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, colors.blue);
}

function logWarning(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

function logError(message) {
  log(`❌ ${message}`, colors.red);
}

function logStep(step, message) {
  log(
    `\n${colors.cyan}${colors.bright}[${step}]${colors.reset} ${message}`,
    colors.white,
  );
}

function logProgress(message) {
  log(`⏳ ${message}`, colors.magenta);
}

function logDivider() {
  log("─".repeat(80), colors.dim);
}

function logBox(content, title = null) {
  const lines = content.split("\n");
  const maxLength = Math.max(...lines.map((line) => line.length));
  const width = maxLength + 4;

  log("┌" + "─".repeat(width) + "┐", colors.cyan);
  if (title) {
    const titlePadding = Math.floor((width - title.length - 2) / 2);
    log(
      "│" +
        " ".repeat(titlePadding) +
        title +
        " ".repeat(width - title.length - titlePadding) +
        "│",
      colors.cyan,
    );
    log("├" + "─".repeat(width) + "┤", colors.cyan);
  }

  lines.forEach((line) => {
    const padding = width - line.length - 2;
    log("│ " + line + " ".repeat(padding) + " │", colors.cyan);
  });

  log("└" + "─".repeat(width) + "┘", colors.cyan);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms, true));
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();

    server.listen(port, () => {
      // Port is available, close the server and resolve true
      server.close(() => {
        resolve(true);
      });
    });

    server.on("error", () => {
      // Port is not available
      resolve(false);
    });
  });
}

function spawnPromise(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.echoOutput ? "inherit" : "pipe",
      ...options,
    });

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

async function checkOllamaInstalled() {
  try {
    await spawnPromise("ollama", ["--version"], { echoOutput: false });
    return true;
  } catch (error) {
    return false;
  }
}

function getTerminalCommand() {
  const platform = process.platform;

  if (platform === "darwin") {
    // macOS
    return ["open", "-a", "Terminal"];
  } else if (platform === "win32") {
    // Windows
    return ["cmd", "/c", "start", "cmd", "/k"];
  } else {
    // Linux and other Unix-like systems
    // Try common terminal emulators in order of preference
    const terminals = [
      "gnome-terminal",
      "konsole",
      "xterm",
      "x-terminal-emulator",
    ];
    for (const terminal of terminals) {
      try {
        execSync(`which ${terminal}`, {
          stdio: "ignore",
        });
        if (terminal === "gnome-terminal") {
          return ["gnome-terminal", "--"];
        } else if (terminal === "konsole") {
          return ["konsole", "-e"];
        } else {
          return [terminal, "-e"];
        }
      } catch (e) {
        // Terminal not found, try next
      }
    }
    // Fallback
    return ["xterm", "-e"];
  }
}

async function openTerminalWithMultipleCommands(commands, title) {
  const platform = process.platform;
  const terminalCmd = getTerminalCommand();

  if (platform === "darwin") {
    // macOS: Chain commands with && separator
    const chainedCommand = commands.join(" && ");
    const script = `tell application "Terminal"
      activate
      do script "${chainedCommand}"
    end tell`;

    await spawnPromise("osascript", ["-e", script], { echoOutput: false });
  } else if (platform === "win32") {
    // Windows: Chain commands with && separator
    const chainedCommand = commands.join(" && ");
    const fullCommand = `${chainedCommand} && pause`;
    await spawnPromise("cmd", ["/c", "start", "cmd", "/k", fullCommand], {
      echoOutput: false,
    });
  } else {
    // Linux and other Unix-like systems: Chain commands with && separator
    const chainedCommand = commands.join(" && ");
    const fullCommand = `${chainedCommand}; read -p "Press Enter to close..."`;
    await spawnPromise(
      terminalCmd[0],
      [...terminalCmd.slice(1), "bash", "-c", fullCommand],
      { echoOutput: false },
    );
  }
}

async function setupOllamaInSingleTerminal(model) {
  logStep("Ollama", `Opening terminal to pull model ${model} and start server`);
  logInfo("Both pull and serve commands will run in the same terminal window");

  try {
    const commands = [`ollama pull ${model}`, `ollama serve`];

    await openTerminalWithMultipleCommands(
      commands,
      `Ollama: Pull ${model} & Serve`,
    );
    logSuccess("Ollama pull and serve started in same terminal");
    logProgress(
      "Waiting for model download to complete and server to start...",
    );

    // Wait a bit for the model pull to start
    await delay(3000);

    // Check if model was pulled successfully and server is ready
    let setupReady = false;
    for (let i = 0; i < 60; i++) {
      // Wait up to 10 minutes for pull + server start
      try {
        // First check if server is responding
        await spawnPromise("ollama", ["list"], { echoOutput: false });

        // Then check if our model is available
        try {
          await spawnPromise("ollama", ["show", model], { echoOutput: false });
          setupReady = true;
          break;
        } catch (e) {
          // Model not ready yet, but server is responding
        }
      } catch (e) {
        // Server not ready yet
      }

      await delay(10000); // Wait 10 seconds between checks
      if (i % 3 === 0) {
        logProgress(
          `Still waiting for model ${model} to be ready and server to start...`,
        );
      }
    }

    if (setupReady) {
      logSuccess(`Model ${model} is ready and Ollama server is running`);
    } else {
      logWarning(
        `Setup may still be in progress. Please check the terminal window.`,
      );
    }
  } catch (error) {
    logError(`Failed to setup Ollama: ${error.message}`);
    throw error;
  }
}

async function main() {
  // Show MCP banner at startup
  console.clear();
  log(MCP_BANNER, colors.cyan);
  logDivider();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const envVars = {};
  let parsingFlags = true;
  let ollamaModel = null;
  let mcpServerCommand = null;
  let mcpServerArgs = [];
  let mcpConfigFile = null;
  let mcpServerName = null;
  let rebuildRequested = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (parsingFlags && arg === "--") {
      parsingFlags = false;
      continue;
    }

    if (parsingFlags && arg === "--ollama" && i + 1 < args.length) {
      ollamaModel = args[++i];
      continue;
    }

    if (parsingFlags && arg === "--port" && i + 1 < args.length) {
      const port = args[++i];
      envVars.PORT = port;
      // Default: localhost in development, 127.0.0.1 in production
      const defaultHost =
        process.env.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1";
      const baseHost = process.env.HOST || defaultHost;
      envVars.BASE_URL = `http://${baseHost}:${port}`;
      continue;
    }

    if (parsingFlags && arg === "--config" && i + 1 < args.length) {
      mcpConfigFile = args[++i];
      continue;
    }

    if (parsingFlags && arg === "--server" && i + 1 < args.length) {
      mcpServerName = args[++i];
      continue;
    }

    if (parsingFlags && (arg === "--rebuild" || arg === "--force-rebuild")) {
      rebuildRequested = true;
      continue;
    }

    if (parsingFlags && arg === "-e" && i + 1 < args.length) {
      const envVar = args[++i];
      const equalsIndex = envVar.indexOf("=");

      if (equalsIndex !== -1) {
        const key = envVar.substring(0, equalsIndex);
        const value = envVar.substring(equalsIndex + 1);
        envVars[key] = value;
      } else {
        envVars[envVar] = "";
      }
      continue;
    }

    // If we encounter a non-flag argument, treat it as MCP server command
    if (parsingFlags && !arg.startsWith("-")) {
      mcpServerCommand = arg;
      // Collect all remaining arguments as server arguments
      mcpServerArgs = args.slice(i + 1);
      break;
    }
  }

  // Allow environment variables to request rebuild as well
  const truthyEnv = new Set(["1", "true", "yes", "on"]);
  const forceRebuildEnv = (process.env.FORCE_REBUILD || "").toLowerCase();
  const rebuildEnv = (process.env.REBUILD || "").toLowerCase();
  if (truthyEnv.has(forceRebuildEnv) || truthyEnv.has(rebuildEnv)) {
    rebuildRequested = true;
  }

  // Handle MCP config file if provided
  if (mcpConfigFile) {
    logStep("MCP Server", `Configuring auto-connection to: ${mcpConfigFile}`);

    try {
      const configPath = resolve(mcpConfigFile);
      if (!existsSync(configPath)) {
        logError(`MCP config file not found: ${configPath}`);
        process.exit(1);
      }

      const configContent = readFileSync(configPath, "utf-8");
      const configData = JSON.parse(configContent);

      if (
        !configData.mcpServers ||
        Object.keys(configData.mcpServers).length === 0
      ) {
        logWarning("No MCP servers found in config file");
      } else {
        // If --server flag is provided, validate it exists but don't filter config
        if (mcpServerName) {
          if (!configData.mcpServers[mcpServerName]) {
            logError(
              `Server '${mcpServerName}' not found in config file. Available servers: ${Object.keys(configData.mcpServers).join(", ")}`,
            );
            process.exit(1);
          }
          logInfo(`Auto-connecting only to server: ${mcpServerName}`);
          // Pass the server filter separately
          envVars.MCP_AUTO_CONNECT_SERVER = mcpServerName;
        }

        // Pass the full config (all servers will show in UI)
        envVars.MCP_CONFIG_DATA = JSON.stringify(configData);
        const serverCount = Object.keys(configData.mcpServers).length;
        const serverNames = Object.keys(configData.mcpServers).join(", ");
        logSuccess(
          `MCP config loaded with ${serverCount} server(s) - showing all in UI`,
        );
        logInfo(`Servers: ${serverNames}`);
        if (mcpServerName) {
          logInfo(`Will auto-connect only to: ${mcpServerName}`);
        } else {
          logInfo(`Will auto-connect to all servers`);
        }
      }
    } catch (error) {
      logError(`Failed to read MCP config file: ${error.message}`);
      process.exit(1);
    }
  } else if (mcpServerCommand) {
    // Handle single MCP server command if provided (legacy mode)
    logStep(
      "MCP Server",
      `Configuring auto-connection to: ${mcpServerCommand} ${mcpServerArgs.join(" ")}`,
    );

    // Pass MCP server config via environment variables
    envVars.MCP_SERVER_COMMAND = mcpServerCommand;
    if (mcpServerArgs.length > 0) {
      envVars.MCP_SERVER_ARGS = JSON.stringify(mcpServerArgs);
    }

    logSuccess(`MCP server will auto-connect on startup`);
  }

  // Handle Ollama setup if requested
  if (ollamaModel) {
    logStep("Setup", "Configuring Ollama integration");

    const isOllamaInstalled = await checkOllamaInstalled();
    if (!isOllamaInstalled) {
      logError("Ollama is not installed. Please install Ollama first:");
      logInfo(
        "Visit https://ollama.ai/download to download and install Ollama",
      );
      process.exit(1);
    }

    logSuccess("Ollama is installed");

    try {
      await setupOllamaInSingleTerminal(ollamaModel);

      logDivider();
      logSuccess(`Ollama setup complete with model: ${ollamaModel}`);
      logInfo("Ollama server is running and ready for MCP connections");
      logDivider();
    } catch (error) {
      logError("Failed to setup Ollama");
      process.exit(1);
    }
  }

  const projectRoot = resolve(__dirname, "..");

  // Apply parsed environment variables to process.env first
  Object.assign(process.env, envVars);

  // Port configuration (fixed default to 6274)
  const requestedPort = 6274;
  let PORT;

  try {
    // Check if user explicitly set a port via --port flag
    const hasExplicitPort = envVars.PORT !== undefined;

    if (hasExplicitPort) {
      logInfo(`Using explicitly requested port: ${requestedPort}`);
      if (await isPortAvailable(requestedPort)) {
        PORT = requestedPort.toString();
        logSuccess(`Port ${requestedPort} is available and ready`);
      } else {
        logError(`Explicitly requested port ${requestedPort} is not available`);
        logInfo(
          "Use a different port with --port <number> or let the system find one automatically",
        );
        throw new Error(`Port ${requestedPort} is already in use`);
      }
    } else {
      // Fixed port policy: use default port 3000 and fail fast if unavailable
      logInfo("No specific port requested, using fixed default port 6274");
      if (await isPortAvailable(requestedPort)) {
        PORT = requestedPort.toString();
        logSuccess(`Default port ${requestedPort} is available`);
      } else {
        logError(
          `Default port ${requestedPort} is already in use. Please free the port`,
        );
        throw new Error(`Port ${requestedPort} is already in use`);
      }
    }

    // Update environment variables with the final port
    envVars.PORT = PORT;
    // Default: localhost in development, 127.0.0.1 in production
    const defaultHost =
      process.env.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1";
    const baseHost = process.env.HOST || defaultHost;
    envVars.BASE_URL = `http://${baseHost}:${PORT}`;
    Object.assign(process.env, envVars);
  } catch (error) {
    logError(`Port configuration failed: ${error.message}`);
    throw error;
  }

  const abort = new AbortController();

  let cancelled = false;
  process.on("SIGINT", () => {
    cancelled = true;
    abort.abort();
    logDivider();
    logWarning("Shutdown signal received...");
    logProgress("Stopping MCP Inspector server");
    logInfo("Cleaning up resources...");
    logSuccess("Server stopped gracefully");
    logDivider();
  });

  try {
    const distServerPath = resolve(projectRoot, "dist", "server", "index.js");

    // Production start behavior:
    // - Do NOT auto-build by default.
    // - If --rebuild (or env) is passed, run a rebuild before starting.
    // - If dist is missing and no rebuild requested, fail fast with guidance.
    const distExists = existsSync(distServerPath);

    if (rebuildRequested) {
      logStep("Build", "Rebuild requested; running production build");
      await spawnPromise("npm", ["run", "build"], {
        env: process.env,
        cwd: projectRoot,
        signal: abort.signal,
        echoOutput: false,
      });
      logSuccess("Build completed successfully");
      await delay(500);
    } else if (!distExists) {
      logError(
        `Production build not found at ${distServerPath}. Build artifacts are required to start.`,
      );
      logInfo(
        "Run this command with --rebuild or build in CI/CD before starting.",
      );
      process.exit(1);
    } else {
      // Small delay to let logs flush before starting
      await delay(500);
    }

    // Spawn the server process but don't wait for it to exit
    const serverProcess = spawn("node", [distServerPath], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: PORT,
      },
      cwd: projectRoot,
      stdio: "inherit",
    });

    // Handle server process errors
    serverProcess.on("error", (error) => {
      if (!cancelled) {
        logError(`Failed to start server: ${error.message}`);
        process.exit(1);
      }
    });

    // Handle abort signal
    abort.signal.addEventListener("abort", () => {
      serverProcess.kill("SIGTERM");
    });

    // Wait a bit for the server to start up
    await delay(2000);

    if (!cancelled) {
      // Open the browser automatically
      // Use BASE_URL if set, otherwise construct from HOST and PORT
      // Default: localhost in development, 127.0.0.1 in production
      const defaultHost =
        process.env.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1";
      const host = process.env.HOST || defaultHost;
      const url = process.env.BASE_URL || `http://${host}:${PORT}`;

      try {
        await open(url);
        logSuccess(`🌐 Browser opened at ${url}`);
      } catch (error) {
        logWarning(
          `Could not open browser automatically. Please visit ${url} manually.`,
        );
      }
    }

    // Wait for the server process to exit
    await new Promise((resolve, reject) => {
      serverProcess.on("close", (code) => {
        if (code === 0 || cancelled) {
          resolve(code);
        } else {
          reject(new Error(`Server process exited with code ${code}`));
        }
      });
    });
  } catch (e) {
    if (!cancelled || process.env.DEBUG) {
      logDivider();
      logError("Failed to start MCP Inspector");
      logError(`Error: ${e.message}`);
      logDivider();
      throw e;
    }
  }

  return 0;
}

main()
  .then((_) => process.exit(0))
  .catch((e) => {
    logError("Fatal error occurred");
    logError(e.stack || e.message);
    process.exit(1);
  });
