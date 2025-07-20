#!/usr/bin/env node

import { resolve, dirname } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_BANNER = `
���W   ���W ������W������W     ��W �����W ���W   ���W
����W ����Q��TPPPP]��TPP��W    ��Q��TPP��W����W ����Q
��T����T��Q��Q     ������T]    ��Q�������Q��T����T��Q
��QZ��T]��Q��Q     ��TPPP]��   ��Q��TPP��Q��QZ��T]��Q
��Q ZP] ��QZ������W��Q    Z�����T]��Q  ��Q��Q ZP] ��Q
ZP]     ZP] ZPPPPP]ZP]     ZPPPP] ZP]  ZP]ZP]     ZP]                                                    
`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms, true));
}

function spawnPromise(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.echoOutput ? 'inherit' : 'pipe',
      ...options
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

async function main() {
  // Clear console and display banner
  console.clear();
  console.log("\x1b[36m%s\x1b[0m", MCP_BANNER); // Cyan color
  console.log("\x1b[33m%s\x1b[0m", "=� Starting Next.js Inspector...\n"); // Yellow color

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

  const abort = new AbortController();

  let cancelled = false;
  process.on("SIGINT", () => {
    cancelled = true;
    abort.abort();
    console.log("\n\x1b[31m%s\x1b[0m", "�  Shutting down Next.js Inspector..."); // Red color
  });

  try {
    console.log("\x1b[32m%s\x1b[0m", " Starting Next.js production server..."); // Green color
    console.log("\x1b[33m%s\x1b[0m", `< Server will be available at http://localhost:${PORT}`);

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
  } catch (e) {
    if (!cancelled || process.env.DEBUG) throw e;
  }

  return 0;
}

main()
  .then((_) => process.exit(0))
  .catch((e) => {
    console.error("\x1b[31m%s\x1b[0m", "L Error:", e); // Red color
    process.exit(1);
  });