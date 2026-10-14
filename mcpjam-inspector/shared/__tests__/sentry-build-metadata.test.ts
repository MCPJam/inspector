import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
