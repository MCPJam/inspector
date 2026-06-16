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

const host: WidgetHost = {
  surface: { kind: "playground", sandboxOrigin: "", webManagedServers: false },
};

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
