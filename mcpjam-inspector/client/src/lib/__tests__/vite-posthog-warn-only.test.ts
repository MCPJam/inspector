import { describe, expect, it } from "vitest";
import { warnOnPosthogFailure } from "../../../vite-posthog-warn-only";

type Hook = {
  handler: (...args: unknown[]) => unknown;
  [option: string]: unknown;
};

function context() {
  const warnings: string[] = [];
  return { warnings, warn: (message: string) => warnings.push(message) };
}

function failing(message: string, options: Record<string, unknown> = {}) {
  return {
    ...options,
    handler: async () => {
      throw new Error(message);
    },
  };
}

describe("warnOnPosthogFailure", () => {
  it("warns instead of failing the build when the upload fails", async () => {
    const plugin = warnOnPosthogFailure({
      name: "posthog-rollup-plugin",
      writeBundle: failing("Command failed with code 1", { sequential: true }),
    });
    const hook = plugin.writeBundle as Hook;
    const ctx = context();

    await expect(hook.handler.call(ctx)).resolves.toBeNull();
    expect(ctx.warnings).toEqual([
      "PostHog source map upload skipped: Command failed with code 1",
    ]);
  });

  it("leaves chunks untouched and warns once when the release lookup fails", async () => {
    const plugin = warnOnPosthogFailure({
      name: "posthog-rollup-plugin",
      renderChunk: failing("posthog-cli release resolve failed with code 1", {
        order: "post",
      }),
    });
    const hook = plugin.renderChunk as Hook;
    const ctx = context();

    await expect(hook.handler.call(ctx, "a();")).resolves.toBeNull();
    await expect(hook.handler.call(ctx, "b();")).resolves.toBeNull();
    expect(ctx.warnings).toHaveLength(1);
  });

  it("keeps hook options so the upload still runs before Sentry deletes the maps", () => {
    const plugin = warnOnPosthogFailure({
      name: "posthog-rollup-plugin",
      renderChunk: failing("x", { order: "post" }),
      writeBundle: failing("x", { sequential: true }),
    });

    expect((plugin.renderChunk as Hook).order).toBe("post");
    expect((plugin.writeBundle as Hook).sequential).toBe(true);
  });

  it("passes results through when PostHog succeeds", async () => {
    const result = { code: "a();\n//# chunkId=1", map: null };
    const plugin = warnOnPosthogFailure({
      name: "posthog-rollup-plugin",
      renderChunk: { order: "post", handler: () => result },
    });
    const ctx = context();

    await expect(
      (plugin.renderChunk as Hook).handler.call(ctx, "a();"),
    ).resolves.toBe(result);
    expect(ctx.warnings).toEqual([]);
  });
});
