#!/usr/bin/env node

import { resolve, dirname } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { execSync } from "child_process";
import { existsSync } from "fs";

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
      server.once("close", () => {
        resolve(true);
      });
      server.close();
    });

    server.on("error", () => {
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort = 3000, maxPort = 3100) {
  for (let port = startPort; port <= maxPort; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `No available ports found between ${startPort} and ${maxPort}`,
  );
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

async function showWelcomeMessage() {
  console.clear();
  log(MCP_BANNER, colors.cyan);

  logDivider();

  const welcomeText = `Welcome to the MCP Inspector! 
This tool helps you explore and interact with Model Context Protocol servers.
Get ready to discover the power of MCP integration.`;

  logBox(welcomeText, "🎯 Getting Started");

  logDivider();
}

async function showServerInfo(port) {
  const serverInfo = `Server URL: http://localhost:${port}
Environment: Production
Framework: Hono + Vite
Architecture: Single Server (API + Static)
Status: Starting up...`;

  logBox(serverInfo, "🌐 Server Configuration");
}

async function showSuccessMessage(port) {
  logDivider();

  const successText = `🎉 MCP Inspector is now running successfully!

📱 Access your application at: ${colors.bright}${colors.green}http://localhost:${port}${colors.reset}
🔧 Server is ready to handle MCP connections
📊 Monitor your MCP tools and resources
💬 Start chatting with your MCP-enabled AI

${colors.dim}Press Ctrl+C to stop the server${colors.reset}`;

  logBox(successText, "🚀 Ready to Go!");

  logDivider();
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
  await showWelcomeMessage();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const envVars = {};
  let parsingFlags = true;
  let ollamaModel = null;

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
      envVars.NEXT_PUBLIC_BASE_URL = `http://localhost:${port}`;
      envVars.BASE_URL = `http://localhost:${port}`;
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
    }
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

  // Get requested port and find available port
  const requestedPort = parseInt(process.env.PORT ?? "3000", 10);
  let PORT;

  try {
    logStep("0", "Checking port availability...");

    if (await isPortAvailable(requestedPort)) {
      PORT = requestedPort.toString();
      logSuccess(`Port ${requestedPort} is available`);
    } else {
      logWarning(`Port ${requestedPort} is in use, finding alternative...`);
      const availablePort = await findAvailablePort(requestedPort + 1);
      PORT = availablePort.toString();
      logSuccess(`Using available port ${availablePort}`);

      // Update environment variables with the new port
      envVars.PORT = PORT;
      envVars.NEXT_PUBLIC_BASE_URL = `http://localhost:${PORT}`;
      envVars.BASE_URL = `http://localhost:${PORT}`;
      Object.assign(process.env, envVars);
    }
  } catch (error) {
    logError(`Failed to find available port: ${error.message}`);
    throw error;
  }

  await showServerInfo(PORT);

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
    const distServerPath = resolve(projectRoot, "dist", "server", "index.cjs");

    // Check if production build exists
    if (!existsSync(distServerPath)) {
      logStep("1", "Production build not found, building now...");
      logProgress("Building client and server for production...");

      await spawnPromise("npm", ["run", "build:migration"], {
        env: process.env,
        cwd: projectRoot,
        signal: abort.signal,
        echoOutput: false,
      });

      logSuccess("Build completed successfully");
      await delay(500);
    } else {
      logStep("1", "Using existing production build");
      await delay(500);
    }

    logStep("2", "Starting Hono server on port " + PORT);
    logProgress("Server handles both API and static files...");

    await spawnPromise("node", [distServerPath], {
      env: {
        ...process.env,
        ...envVars,
        NODE_ENV: "production",
        PORT: PORT,
      },
      cwd: projectRoot,
      signal: abort.signal,
      echoOutput: true,
    });

    if (!cancelled) {
      await showSuccessMessage(PORT);
    }
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
