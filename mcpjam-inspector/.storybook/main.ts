import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import remarkGfm from "remark-gfm";

// Explicit `.ts` extension: Storybook evaluates this file through Node's ESM
// loader, which does not do extension resolution. Without it the server dies at
// startup with ERR_MODULE_NOT_FOUND. The client tsconfig sets
// `allowImportingTsExtensions`, so the typecheck accepts it too.
import clientViteConfig from "../client/vite.config.ts";

/**
 * Storybook's entry point. It answers three questions: WHERE the stories are,
 * WHAT extra features are on, and HOW the dev server resolves imports.
 *
 * This lives in `mcpjam-inspector` rather than in `design-system` on purpose.
 * Three of the four error patterns (ErrorCard, the toast wrapper and the
 * full-page error screens) are app components, and the
 * design system cannot import them: the app depends on `@mcpjam/design-system`,
 * so importing back the other way is a dependency cycle. A Storybook in the
 * design system could therefore only ever show replicas of them, and a replica
 * drifts from the product and starts quietly lying. From here stories can
 * import the real components, including the design system's own by its
 * published path. Not every story does yet; the docs page lists which
 * specimens are real and which are drawn.
 */
const config: StorybookConfig = {
  stories: ["../stories/**/*.mdx", "../stories/**/*.stories.@(ts|tsx)"],

  /**
   * `addon-docs` renders the `.mdx` pages. `remark-gfm` is passed to it because
   * Storybook's MDX does NOT enable GitHub Flavored Markdown by default, so a
   * markdown table renders as literal pipe characters — silently, with no
   * warning and no console error. GFM also restores strikethrough and task
   * lists.
   */
  addons: [
    {
      name: "@storybook/addon-docs",
      options: {
        mdxPluginOptions: {
          mdxCompileOptions: { remarkPlugins: [remarkGfm] },
        },
      },
    },
  ],

  framework: { name: "@storybook/react-vite", options: {} },

  /**
   * The stories import real app components, so Storybook has to resolve imports
   * exactly as the app does — `@/lib/clipboard`, `@mcpjam/sdk/browser` and the
   * rest. Rather than restate that alias map (around twenty entries, several
   * computed), this reuses the client's own Vite config as the single source of
   * truth. Copying it would have reproduced the drift problem described above,
   * one layer down.
   *
   * Only `resolve` is taken. The client's plugin chain carries Sentry, PostHog
   * source maps, telemetry catalog generation and a custom minifier — all of
   * which belong to a production build of the app and none of which a component
   * gallery should run.
   *
   * `tailwindcss()` is re-added for the same reason `preview.css` exists.
   *
   * `esbuild.jsx` has to be set explicitly, and the reason is worth recording.
   * Vite infers the JSX transform from the nearest tsconfig, and the nearest
   * one to `stories/` is `mcpjam-inspector/tsconfig.json`, which sets
   * `"jsx": "preserve"` (it is the Next-style config for the repo root, not for
   * the React client). Left alone, every story failed to render with "React is
   * not defined". `client/tsconfig.json` sets `react-jsx`, but it only governs
   * files under `client/`.
   *
   * `mode: "development"` / `command: "serve"` matches how the dev server calls
   * it, so any env-dependent branch resolves the way it does under `dev:client`.
   */
  viteFinal: async (viteConfig) => {
    const client = await clientViteConfig({
      mode: "development",
      command: "serve",
    });

    viteConfig.resolve = {
      ...viteConfig.resolve,
      ...client.resolve,
      alias: {
        ...(client.resolve?.alias as Record<string, string>),
        // Storybook's own aliases win: it injects a few of its own that the
        // preview depends on, and losing them breaks the manager/preview split.
        ...(viteConfig.resolve?.alias as Record<string, string>),
      },
    };

    viteConfig.esbuild = { ...viteConfig.esbuild, jsx: "automatic" };
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()];
    return viteConfig;
  },
};

export default config;
