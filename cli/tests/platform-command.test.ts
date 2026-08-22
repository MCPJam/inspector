import assert from "node:assert/strict";
import { Command } from "commander";
import test from "node:test";
import {
  platformOptionsOf,
  type PlatformOptions,
} from "../src/lib/platform-command.js";

test("platformOptionsOf prefers the nearest declaration over an ancestor", async () => {
  const parent = new Command("cloud").exitOverride();
  parent.option("--api-key <key>");
  parent.option("--api-url <url>");
  const child = parent.command("whoami").exitOverride();
  child.option("--api-key <key>");
  child.option("--api-url <url>");

  let captured: PlatformOptions | undefined;
  child.action((_options, invoked: Command) => {
    captured = platformOptionsOf<PlatformOptions>(invoked);
  });

  await parent.parseAsync(
    [
      "node",
      "cloud",
      "--api-key",
      "from-parent",
      "--api-url",
      "https://parent.example/api/v1",
      "whoami",
      "--api-key",
      "from-leaf",
    ],
    { from: "node" }
  );

  assert.equal(captured?.apiKey, "from-leaf");
  assert.equal(captured?.apiUrl, "https://parent.example/api/v1");
});

test("platformOptionsOf recovers a flag consumed by an ancestor group", async () => {
  const parent = new Command("projects").exitOverride();
  parent.option("--project <id-or-name>");
  const child = parent.command("list").exitOverride();
  child.option("--project <id-or-name>");

  let captured: { project?: string } | undefined;
  child.action((_options, invoked: Command) => {
    captured = platformOptionsOf<{ project?: string }>(invoked);
  });

  await parent.parseAsync(["node", "projects", "--project", "alpha", "list"], {
    from: "node",
  });

  assert.equal(captured?.project, "alpha");
});
