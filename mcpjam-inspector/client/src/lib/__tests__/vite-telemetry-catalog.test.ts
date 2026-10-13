import { expect, it, vi } from "vitest";
import {
  emittedFunctionNames,
  telemetryCatalogPlugin,
} from "../../../vite-telemetry-catalog";

it("derives function names from emitted syntax, not strings or comments", () => {
  expect(
    emittedFunctionNames(
      'function approved(){}; const a=()=>{}; const text="function SENTINEL(){}"; // function SECRET(){}',
    ),
  ).toEqual([
    "Module.a",
    "Module.approved",
    "Object.a",
    "Object.approved",
    "a",
    "approved",
    "new a",
    "new approved",
  ]);
});

it("emits a hashed catalog before the app executes and covers exact asset paths", async () => {
  const emitFile = vi.fn();
  const bundle = {
    "assets/app-Ab1.js": {
      type: "chunk",
      fileName: "assets/app-Ab1.js",
      code: "function ownFrame(){}",
    },
    "index.html": {
      type: "asset",
      fileName: "index.html",
      source:
        '<head></head><script type="module" src="/assets/app-Ab1.js"></script>',
    },
  };
  const plugin = telemetryCatalogPlugin();
  const handler = plugin.generateBundle;
  if (typeof handler !== "function") throw new Error("missing build hook");
  await handler.call(
    { emitFile } as never,
    {} as never,
    bundle as never,
    false,
  );
  expect(emitFile).toHaveBeenCalledOnce();
  const asset = emitFile.mock.calls[0][0];
  expect(asset.fileName).toMatch(
    /^assets\/telemetry-catalog-[0-9a-f]{16}\.js$/,
  );
  expect(asset.source).toContain('"assets/app-Ab1.js"');
  expect(asset.source).toContain('"ownFrame"');
  expect(bundle["index.html"].source.indexOf(asset.fileName)).toBeLessThan(
    bundle["index.html"].source.indexOf('type="module"'),
  );
});
