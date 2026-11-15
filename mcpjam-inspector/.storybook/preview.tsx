import * as React from "react";
import type { Decorator, Preview } from "@storybook/react-vite";
import { Toaster } from "@mcpjam/design-system/sonner";

import "./preview.css";

/**
 * Settings that apply to EVERY story. `main.ts` says where stories are; this
 * says what the world around them looks like.
 *
 * Two jobs: a light/dark switch in the toolbar, and a mounted `<Toaster>` so
 * toast stories have somewhere to render.
 */

/**
 * The theme switch.
 *
 * `design-system/src/tokens.css` declares `@custom-variant dark (&:is(.dark *))`,
 * so dark mode is a `.dark` class on an ANCESTOR — not a media query, not a
 * prop, and not `next-themes` (the app provides no theme provider at all).
 * Toggling the class on `<html>` is the entire mechanism, same as the app.
 *
 * It must be the document element rather than a wrapper div, because
 * `design-system/src/components/sonner.tsx` reads the theme with
 * `document.documentElement.classList.contains("dark")`. A wrapper would style
 * the components correctly and leave the toasts in the wrong theme.
 */
const withTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme as "light" | "dark";

  React.useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    return () => root.classList.remove("dark");
  }, [theme]);

  return <Story />;
};

/**
 * Mounts the toast host once for the whole preview — the same `<Toaster>` the
 * app mounts in `App.tsx`, imported from the same place.
 *
 * Sonner renders toasts into this host rather than into the story's own tree,
 * so a `toast.error()` in a story with no `<Toaster>` anywhere succeeds and
 * displays nothing.
 */
const withToaster: Decorator = (Story) => (
  <>
    <Story />
    <Toaster position="bottom-right" />
  </>
);

const preview: Preview = {
  decorators: [withToaster, withTheme],

  parameters: {
    /**
     * Disabled because the body is already painted from `--background` in
     * `preview.css`. Storybook's own background picker would be a second,
     * competing control.
     */
    backgrounds: { disable: true },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    docs: { toc: true },
  },

  globalTypes: {
    theme: {
      description: "Light or dark role tokens",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "light", icon: "sun", title: "Light" },
          { value: "dark", icon: "moon", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },

  initialGlobals: { theme: "light" },
};

export default preview;
