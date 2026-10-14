import { build, type BuildOptions } from "esbuild";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import config from "../tsup.config";

it("bundles the telemetry subpath without rewriting it under the SDK root entry", async () => {
  if (typeof config === "function" || Array.isArray(config)) {
    throw new Error("Expected the server build configuration");
  }
  const options: BuildOptions = {
    bundle: true,
    write: false,
    format: "cjs",
    stdin: {
      contents: `import { telemetryActorId } from "@mcpjam/sdk/internal/telemetry";
module.exports = { accepted: telemetryActorId("abcdef0123456789"), rejected: telemetryActorId("private@example.test") };`,
    },
  };
  config.esbuildOptions?.(options, { format: "cjs" });
  const target = options.alias?.["@mcpjam/sdk/internal/telemetry"];
  expect(target).toMatch(/\/sdk\/dist\/internal\/telemetry\.js$/);
  if (!target) throw new Error("The telemetry subpath needs an explicit alias");
  // Exercise the alias with source so this test also runs before an SDK build.
  options.alias = {
    ...options.alias,
    "@mcpjam/sdk/internal/telemetry": target
      .replace("/sdk/dist/", "/sdk/src/")
      .replace(/\.js$/, ".ts"),
  };
  const result = await build(options);
  const context = { module: { exports: {} } };
  runInNewContext(result.outputFiles![0].text, context);
  expect(context.module.exports).toEqual({
    accepted: "abcdef0123456789",
    rejected: undefined,
  });
});
