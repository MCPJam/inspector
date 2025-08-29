#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "../dist/index.js");

import(cliPath).catch((err) => {
  console.error("Failed to start MCPJam CLI:", err.message);
  process.exit(1);
});
