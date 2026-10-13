import { spawn } from "node:child_process";
import { createLaunchToken, createAccessLink } from "../bin/access-link.mjs";

const token = createLaunchToken();
if (token) {
  // Terminal only: never send the access link through telemetry loggers.
  process.stdout.write(
    `\n➜ Dev\n${createAccessLink(
      process.env.MCPJAM_INSPECTOR_FRONTEND_URL ||
        `http://localhost:${process.env.CLIENT_PORT || 5173}`,
      token,
    )}\nKeep this link private: it signs a browser in.\n\n`,
  );
}
const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", process.argv[2] || "dev:processes"],
  {
    stdio: "inherit",
    env: { ...process.env, ...(token ? { MCPJAM_SESSION_TOKEN: token } : {}) },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
