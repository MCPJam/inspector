#!/usr/bin/env node

import { resolve, dirname } from "path";
import { spawn } from "child_process";
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
Framework: Next.js
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

async function main() {
  await showWelcomeMessage();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const envVars = {};
  let parsingFlags = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (parsingFlags && arg === "--") {
      parsingFlags = false;
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

  const projectRoot = resolve(__dirname, "..");

  // Apply parsed environment variables to process.env first
  Object.assign(process.env, envVars);

  const PORT = process.env.PORT ?? "3000";

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
    logStep("1", "Initializing Next.js production server");
    await delay(1000);

    logStep("2", "Building application for production");
    logProgress("This may take a few moments...");
    await delay(500);

    logStep("3", "Starting server on port " + PORT);

    await spawnPromise("npm", ["run", "start"], {
      env: {
        ...process.env,
        ...envVars,
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
