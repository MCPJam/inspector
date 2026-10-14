import { expect, it, vi } from "vitest";
import { telemetryCatalogPlugin } from "../../../vite-telemetry-catalog";

it("emits only exact build-owned file inventory before the app executes", async () => {
  const emitFile = vi.fn();
  const bundle = {
    "assets/app-Ab1.js": { type: "chunk", fileName: "assets/app-Ab1.js", code: "function PRIVATE_SENTINEL(){}" },
    "index.html": { type: "asset", fileName: "index.html", source: '<head></head><script type="module" src="/assets/app-Ab1.js"></script>' },
  };
  const handler = telemetryCatalogPlugin().generateBundle;
  if (typeof handler !== "function") throw new Error("missing build hook");
  await handler.call({ emitFile } as never, {} as never, bundle as never, false);
  expect(emitFile).toHaveBeenCalledOnce();
  const asset = emitFile.mock.calls[0][0];
  expect(asset.fileName).toMatch(/^assets\/telemetry-files-[0-9a-f]{16}\.js$/);
  expect(asset.source).toContain('"assets/app-Ab1.js"');
  expect(asset.source).not.toContain("PRIVATE_SENTINEL");
  expect(bundle["index.html"].source.indexOf(asset.fileName)).toBeLessThan(bundle["index.html"].source.indexOf('type="module"'));
});
