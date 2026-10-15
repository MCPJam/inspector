import { execFileSync } from "node:child_process";

// Build the real entry point without inheriting account-specific client config
// or enabling source-map uploads and session recorders on a developer machine.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")),
);
Object.assign(env, {
  MCPJAM_RESOLVED_RUNTIME: "1",
  MCPJAM_BUILD_SURFACE: "local",
  VITE_CONVEX_URL: "https://visual.invalid",
  VITE_WORKOS_CLIENT_ID: "visual-test",
  VITE_MCPJAM_HOSTED_MODE: "false",
  VITE_DISABLE_POSTHOG_LOCAL: "true",
  SENTRY_AUTH_TOKEN: "",
  POSTHOG_PERSONAL_API_KEY: "",
  METICULOUS_RECORDING_TOKEN: "",
});
// The capture fixture serves the production iframe sandbox, whose generated
// module is absent on a fresh checkout.
execFileSync(process.execPath, ["scripts/bundle-sandbox-proxy-html.js"], {
  env,
  stdio: "inherit",
});
for (const hosted of [false, true]) {
  env.VITE_MCPJAM_HOSTED_MODE = String(hosted);
  env.VITE_MCPJAM_SANDBOX_ORIGIN = "https://sandbox.visual.invalid";
  execFileSync(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "build",
      "--config",
      "client/vite.config.ts",
      "--outDir",
      hosted ? "../dist/visual-hosted" : "../dist/client",
    ],
    { env, stdio: "inherit" },
  );
}
