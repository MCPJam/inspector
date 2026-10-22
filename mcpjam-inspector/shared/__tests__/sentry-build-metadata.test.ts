import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createStackParser, nodeStackLineParser } from "@sentry/core";
import { expect, it } from "vitest";
import { sentryBuildMetadata } from "../sentry-build-metadata";

it("binds map IDs only to fixed package files and recognizes Electron's normalized aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "sentry-build-"));
  const file = ".vite/build/main.cjs";
  const id = "bd2cfb5e-a428-4bad-91f5-4656d832cf73";
  try {
    mkdirSync(join(root, ".vite/build"), { recursive: true });
    writeFileSync(
      join(root, file),
      `globalThis._sentryDebugIdIdentifier="sentry-dbid-${id}";`,
    );
    const metadata = sentryBuildMetadata(root, [file]);
    expect(metadata.frameAliases).toEqual({
      [join(root, file)]: file,
      [join(root, file).split(sep).join("/")]: file,
      [pathToFileURL(join(root, file)).href]: file,
      [`app:///${file}`]: file,
    });
    expect(metadata.frameOutputNames).toEqual({ [file]: `app:///${file}` });
    expect(metadata.frameDebugIds).toEqual({ [`app:///${file}`]: id });
    expect(sentryBuildMetadata(root, ["missing.js"]).frameDebugIds).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("owns the path Sentry parses from a Windows ESM frame, and only under the verified root", () => {
  const parse = createStackParser(nodeStackLineParser());
  const frame = (url: string) =>
    parse(`Error: x\n    at fail (${url}:12:7)`)[0]?.filename ?? "";
  const owned = frame("file:///C:/Program%20Files/MCPJam/dist/server/index.js");
  const customer = frame("file:///C:/Users/me/app/dist/server/index.js");
  expect(owned).toBe("C:/Program Files/MCPJam/dist/server/index.js");
  const { frameAliases } = sentryBuildMetadata(
    "C:\\Program Files\\MCPJam",
    ["dist/server/index.js"],
    true,
  );
  expect(frameAliases[owned]).toBe("dist/server/index.js");
  expect(frameAliases[customer]).toBeUndefined();
});
