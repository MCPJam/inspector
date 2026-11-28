import { beforeEach, describe, expect, it } from "vitest";
import { useHostContextStore } from "../client-context-store";

const styles = {
  variables: {
    "--color-background-primary": "rgb(14, 14, 14)",
    "--color-text-primary": "rgb(237, 237, 237)",
    "--color-text-secondary": "light-dark(#333, #ccc)",
    "--font-sans": "Custom Sans",
    "--border-radius-md": "12px",
  },
  css: { fonts: "@font-face { font-family: Custom Sans; }" },
};

describe("client context theme changes", () => {
  beforeEach(() => {
    useHostContextStore.setState(useHostContextStore.getInitialState());
  });

  it.each([
    ["dark", "light"],
    ["light", "dark"],
    [undefined, "dark"],
  ])("replaces the %s palette when switching to %s", (from, to) => {
    const original = { theme: from, locale: "fr-FR", styles };
    useHostContextStore.getState().loadProjectHostContext({
      projectId: "project-1",
      defaultHostContext: {},
      savedHostContext: original,
    });

    useHostContextStore.getState().patchHostContext({ theme: to });

    const state = useHostContextStore.getState();
    expect(state.draftHostContext).toEqual({
      theme: to,
      locale: "fr-FR",
      styles: {
        css: styles.css,
        variables: {
          "--color-text-secondary": "light-dark(#333, #ccc)",
          "--font-sans": "Custom Sans",
          "--border-radius-md": "12px",
        },
      },
    });
    expect(JSON.parse(state.hostContextText)).toEqual(state.draftHostContext);
    expect(state.isDirty).toBe(true);
    expect(state.savedHostContext).toEqual(original);
    expect(original.styles.variables["--color-background-primary"]).toBe(
      "rgb(14, 14, 14)",
    );
    state.resetToBaseline();
    expect(useHostContextStore.getState().draftHostContext).toEqual(original);
    expect(useHostContextStore.getState().isDirty).toBe(false);
  });

  it.each([{ theme: "dark" }, { locale: "de-DE" }])(
    "preserves custom colors when the theme does not change: %j",
    (patch) => {
      useHostContextStore
        .getState()
        .applyHostTemplate({ theme: "dark", styles });
      useHostContextStore.getState().patchHostContext(patch);
      expect(useHostContextStore.getState().draftHostContext.styles).toEqual(
        styles,
      );
    },
  );

  it("preserves a palette explicitly supplied with a new theme", () => {
    useHostContextStore.getState().applyHostTemplate({ theme: "dark", styles });
    const replacement = { variables: { "--color-background-primary": "pink" } };
    useHostContextStore
      .getState()
      .patchHostContext({ theme: "light", styles: replacement });
    expect(useHostContextStore.getState().draftHostContext.styles).toEqual(
      replacement,
    );
  });

  it("leaves raw JSON edits in control of both theme and styles", () => {
    const explicit = { theme: "light", styles };
    useHostContextStore.getState().setHostContextText(JSON.stringify(explicit));
    expect(useHostContextStore.getState().draftHostContext).toEqual(explicit);
  });

  it.each([undefined, null, [], "custom", {}, { variables: null }])(
    "accepts a theme change without a color map: %j",
    (value) => {
      useHostContextStore
        .getState()
        .applyHostTemplate({ theme: "dark", styles: value });
      useHostContextStore.getState().patchHostContext({ theme: "light" });
      expect(useHostContextStore.getState().draftHostContext).toMatchObject({
        theme: "light",
      });
      expect(useHostContextStore.getState().draftHostContext.styles).toEqual(
        value,
      );
    },
  );
});
