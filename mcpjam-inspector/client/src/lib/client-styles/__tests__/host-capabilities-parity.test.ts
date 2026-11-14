import { describe, expect, it } from "vitest";
import { resolveBuiltInHostCapabilities } from "@/shared/host-style-capabilities";
import { resolveEffectiveHostCapabilities } from "@/lib/client-config-v2";
import { BUILT_IN_HOST_STYLES } from "../built-ins";

/**
 * Eval and swarm advertise through `resolveBuiltInHostCapabilities`, chat
 * through the client registry. Same input, same advertised capabilities.
 */
describe("eval and chat host capability parity", () => {
  it.each(BUILT_IN_HOST_STYLES.map((style) => style.id))("%s", (hostStyle) => {
    for (const profile of [
      undefined,
      { profileVersion: 1 as const, apps: { mcpAppsOverrides: { serverResources: false } } },
      { profileVersion: 1 as const, apps: { mcpAppsOverrides: { message: true, downloadFile: true } } },
    ]) {
      expect(resolveBuiltInHostCapabilities({ hostStyle, profile })).toEqual(
        resolveEffectiveHostCapabilities({ hostStyle, profile }),
      );
    }
  });
});
