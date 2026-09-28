type HookContext = { warn: (message: string) => void };
type ObjectHook = {
  handler: (this: HookContext, ...args: unknown[]) => unknown;
};

/**
 * `@posthog/rollup-plugin` has no option to warn instead of fail, so a PostHog
 * outage or a bad key would fail `build:client` and block the Railway deploy.
 * `sentryVitePlugin` only warns in the same case; this makes PostHog match.
 *
 * Only the two hooks that call PostHog are wrapped: `renderChunk` resolves the
 * release (`posthog-cli release resolve`) and `writeBundle` uploads. When the
 * release lookup fails, the chunks keep their code and carry no chunk id, so
 * `writeBundle` has nothing to upload. Hook options (`order`, `sequential`)
 * are kept, so the upload still finishes before Sentry deletes the maps.
 */
export function warnOnPosthogFailure<
  P extends { renderChunk?: unknown; writeBundle?: unknown },
>(plugin: P): P {
  return {
    ...plugin,
    renderChunk: warnInsteadOfThrow(plugin.renderChunk),
    writeBundle: warnInsteadOfThrow(plugin.writeBundle),
  };
}

function warnInsteadOfThrow(hook: unknown): unknown {
  if (!hook || typeof hook !== "object") return hook;
  const { handler, ...options } = hook as ObjectHook;
  // `renderChunk` runs once per chunk and they all share one failed lookup.
  let warned = false;
  return {
    ...options,
    async handler(this: HookContext, ...args: unknown[]) {
      try {
        return await handler.apply(this, args);
      } catch (error) {
        if (!warned) {
          warned = true;
          const reason = error instanceof Error ? error.message : String(error);
          this.warn(`PostHog source map upload skipped: ${reason}`);
        }
        return null;
      }
    },
  };
}
