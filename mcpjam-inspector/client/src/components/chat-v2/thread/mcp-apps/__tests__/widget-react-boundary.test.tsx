import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
// Import through the SAME "@mcpjam/widget-react" alias the inspector
// build/dev/typecheck use (client tsconfig paths + vite + vitest configs). This
// is the package-consumer smoke test: it catches cross-boundary wiring breakage
// (alias resolution, source/ESM/JSX) before 3d relocates the renderer into the
// package and the live chat depends on this path.
import {
  WidgetHostProvider,
  useWidgetHost,
  type WidgetHost,
} from "@mcpjam/widget-react";

function SurfaceProbe() {
  const host = useWidgetHost();
  return <div data-testid="surface-kind">{host.surface.kind}</div>;
}

describe("@mcpjam/widget-react package boundary (inspector consumer)", () => {
  it("resolves through the inspector alias and reads the host via the provider", () => {
    // Stand-in for the value the inspector's use-widget-host adapter feeds the
    // provider in 3d. Its surface is a structural subset of the adapter's
    // WidgetSurfaceInfo, so the real adapter will satisfy this contract too.
    const host: WidgetHost = {
      surface: { kind: "chat", sandboxOrigin: "", webManagedServers: false },
    };
    render(
      <WidgetHostProvider value={host}>
        <SurfaceProbe />
      </WidgetHostProvider>,
    );
    expect(screen.getByTestId("surface-kind").textContent).toBe("chat");
  });

  it("requires the inspector to wrap the subtree in the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Orphan() {
      useWidgetHost();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/WidgetHostProvider/);
    spy.mockRestore();
  });
});
