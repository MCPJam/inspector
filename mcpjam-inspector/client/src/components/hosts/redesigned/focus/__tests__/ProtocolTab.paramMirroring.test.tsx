import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({
    rawContent,
    onRawChange,
  }: {
    rawContent: string;
    onRawChange: (next: string) => void;
  }) => (
    <textarea
      aria-label="json"
      value={rawContent}
      onChange={(e) => onRawChange(e.target.value)}
    />
  ),
}));

import { ProtocolTab, protocolToJson, applyJsonToDraft } from "../ProtocolTab";

function Harness({ initial }: { initial: HostConfigInputV2 }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div>
      <div data-testid="mirroring">
        {draft.mcpProfile?.toolParamHeaderMirroring ?? "<undefined>"}
      </div>
      <div data-testid="profile">
        {draft.mcpProfile === undefined ? "<no-profile>" : "profile"}
      </div>
      <ProtocolTab
        draft={draft}
        onDraftChange={(updater) => setDraft((prev) => updater(prev))}
        attention={[]}
      />
    </div>
  );
}

const combo = () =>
  screen.getByRole("combobox", { name: "Mcp-Param-* mirroring" });

/**
 * The knob's whole value is that "Mirror" and "not configured" are the SAME
 * stored state. If the default ever started writing a literal, every host that
 * merely opened this tab would get a new canonical hash.
 */
describe("ProtocolTab Mcp-Param-* mirroring control", () => {
  it("shows Mirror for a host that never configured it", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);
    expect(combo()).toHaveTextContent("Mirror (default)");
    expect(screen.getByTestId("mirroring").textContent).toBe("<undefined>");
  });

  it("stores 'omit' when the user picks the non-conforming simulation", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(combo());
    await user.click(
      await screen.findByRole("option", {
        name: "Omit (simulate non-conforming client)",
      }),
    );

    expect(screen.getByTestId("mirroring").textContent).toBe("omit");
  });

  it("writes ABSENCE when switched back to Mirror, collapsing the envelope", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...emptyHostConfigInputV2(),
          mcpProfile: { profileVersion: 1, toolParamHeaderMirroring: "omit" },
        }}
      />,
    );

    await user.click(combo());
    await user.click(await screen.findByRole("option", { name: "Mirror (default)" }));

    expect(screen.getByTestId("mirroring").textContent).toBe("<undefined>");
    // The envelope existed ONLY to carry this field, so clearing it must clear
    // the envelope too — otherwise the host hashes differently from one that
    // never opted in.
    expect(screen.getByTestId("profile").textContent).toBe("<no-profile>");
  });

  it("explains what Omit actually does", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);
    await user.click(combo());
    await user.click(
      await screen.findByRole("option", {
        name: "Omit (simulate non-conforming client)",
      }),
    );
    expect(screen.getByText(/-32020 HeaderMismatch/)).toBeTruthy();
  });
});

describe("ProtocolTab JSON round-trip for toolParamHeaderMirroring", () => {
  const withMirroring = (value: unknown): HostConfigInputV2 => ({
    ...emptyHostConfigInputV2(),
    mcpProfile: {
      profileVersion: 1,
      toolParamHeaderMirroring: value as "omit",
    },
  });

  it("omits the key entirely when unset", () => {
    expect(protocolToJson(emptyHostConfigInputV2())).not.toHaveProperty(
      "toolParamHeaderMirroring",
    );
  });

  it("surfaces and re-applies a stored value", () => {
    const doc = protocolToJson(withMirroring("omit"));
    expect(doc.toolParamHeaderMirroring).toBe("omit");
    const back = applyJsonToDraft(doc, emptyHostConfigInputV2());
    expect(back?.mcpProfile?.toolParamHeaderMirroring).toBe("omit");
  });

  it("collapses an unknown literal to undefined instead of failing the save", () => {
    // A hand-edited junk value must not reach the canonicalizer, which throws
    // on an unknown literal and would reject the whole host.
    const back = applyJsonToDraft(
      {
        ...protocolToJson(emptyHostConfigInputV2()),
        toolParamHeaderMirroring: "corrupt",
      },
      withMirroring("omit"),
    );
    expect(back?.mcpProfile?.toolParamHeaderMirroring).toBeUndefined();
  });
});
