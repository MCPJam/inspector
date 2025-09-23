#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../dist/index.js");

const fixedCliPath = process.platform === "win32"
  ? pathToFileURL(cliPath).href
  : cliPath;

import(fixedCliPath).catch((err) => {
  console.error("Failed to start MCPJam CLI:", err.message);
  process.exit(1);
});
