import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  WidgetHostProvider,
  useWidgetHost,
  type WidgetHost,
} from "../index";

function SurfaceProbe() {
  const host = useWidgetHost();
  return <span data-testid="kind">{host.surface.kind}</span>;
}

// Minimal host for the provider/hook plumbing test (the probe reads only
// `surface.kind`). The FULL WidgetHost contract is type-checked where it matters
// — the inspector's use-widget-host adapter conforming to it (typecheck:client).
const host = {
  surface: {
    kind: "playground",
    persistentSurfaceHost: false,
    webManagedServers: false,
    sandboxOrigin: "",
    playgroundCspMode: "widget-declared",
  },
} as unknown as WidgetHost;

describe("WidgetHostProvider / useWidgetHost", () => {
  it("provides the injected host to consumers", () => {
    const { getByTestId } = render(
      <WidgetHostProvider value={host}>
        <SurfaceProbe />
      </WidgetHostProvider>,
    );
    expect(getByTestId("kind").textContent).toBe("playground");
  });

  it("throws when used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Orphan() {
      useWidgetHost();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/WidgetHostProvider/);
    spy.mockRestore();
  });
});
