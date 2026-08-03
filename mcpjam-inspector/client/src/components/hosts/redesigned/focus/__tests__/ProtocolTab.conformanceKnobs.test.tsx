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
      <div data-testid="pagination">
        {draft.mcpProfile?.paginationTraversal ?? "<undefined>"}
      </div>
      <div data-testid="mrtr">
        {draft.mcpProfile?.mrtrSupport ?? "<undefined>"}
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

const paginationCombo = () =>
  screen.getByRole("combobox", { name: "Paginated list traversal" });
const mrtrCombo = () =>
  screen.getByRole("combobox", { name: "Multi-round tool results" });

/**
 * Like the mirroring knob beside them, these controls' whole value is that
 * the DEFAULT and "not configured" are the same stored state. If picking the
 * default ever wrote a literal, every host that merely opened this tab would
 * get a new canonical hash — and, because the backend content-addresses host
 * configs, a new row.
 */
describe("ProtocolTab client-conformance controls", () => {
  it("shows the defaults for a host that never configured them", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);
    expect(paginationCombo()).toHaveTextContent("Walk every page (default)");
    expect(mrtrCombo()).toHaveTextContent("Supported (default)");
    expect(screen.getByTestId("pagination").textContent).toBe("<undefined>");
    expect(screen.getByTestId("mrtr").textContent).toBe("<undefined>");
  });

  it("stores the degraded value when the user picks it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(paginationCombo());
    await user.click(screen.getByRole("option", { name: "First page only" }));
    expect(screen.getByTestId("pagination").textContent).toBe("firstPageOnly");

    await user.click(mrtrCombo());
    await user.click(screen.getByRole("option", { name: "Not supported" }));
    expect(screen.getByTestId("mrtr").textContent).toBe("none");
  });

  it("writes ABSENCE when the user picks the default back", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...emptyHostConfigInputV2(),
          mcpProfile: {
            profileVersion: 1,
            paginationTraversal: "firstPageOnly",
            mrtrSupport: "none",
          },
        }}
      />,
    );

    await user.click(paginationCombo());
    await user.click(
      screen.getByRole("option", { name: "Walk every page (default)" }),
    );
    expect(screen.getByTestId("pagination").textContent).toBe("<undefined>");

    await user.click(mrtrCombo());
    await user.click(
      screen.getByRole("option", { name: "Supported (default)" }),
    );
    expect(screen.getByTestId("mrtr").textContent).toBe("<undefined>");
    // Nothing left in the profile ⇒ it collapses, so the host hashes exactly
    // as one that never opened this tab.
    expect(screen.getByTestId("profile").textContent).toBe("<no-profile>");
  });

  it("keeps a profile alive while a SIBLING field is still set", async () => {
    // The regression the shared `isMcpProfileEmpty` helper guards: the
    // collapse check used to be inlined per setter, so a field the setter
    // didn't know about could be silently dropped on the next edit.
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...emptyHostConfigInputV2(),
          mcpProfile: {
            profileVersion: 1,
            paginationTraversal: "firstPageOnly",
            mrtrSupport: "none",
          },
        }}
      />,
    );

    await user.click(paginationCombo());
    await user.click(
      screen.getByRole("option", { name: "Walk every page (default)" }),
    );

    expect(screen.getByTestId("pagination").textContent).toBe("<undefined>");
    // mrtrSupport survives — clearing one knob must not take the other with it.
    expect(screen.getByTestId("mrtr").textContent).toBe("none");
    expect(screen.getByTestId("profile").textContent).toBe("profile");
  });
});

describe("ProtocolTab JSON round-trip for the conformance knobs", () => {
  it("omits the keys entirely when unset", () => {
    const doc = protocolToJson(emptyHostConfigInputV2());
    expect("paginationTraversal" in doc).toBe(false);
    expect("mrtrSupport" in doc).toBe(false);
  });

  it("surfaces and re-applies stored values", () => {
    const draft: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1,
        paginationTraversal: "firstPageOnly",
        mrtrSupport: "none",
      },
    };
    const doc = protocolToJson(draft);
    expect(doc.paginationTraversal).toBe("firstPageOnly");
    expect(doc.mrtrSupport).toBe("none");

    const applied = applyJsonToDraft(doc, emptyHostConfigInputV2());
    expect(applied).not.toBeNull();
    expect(applied!.mcpProfile?.paginationTraversal).toBe("firstPageOnly");
    expect(applied!.mcpProfile?.mrtrSupport).toBe("none");
  });

  it("collapses unknown literals to undefined instead of failing the save", () => {
    // The canonicalizer THROWS on an unknown literal, which would reject the
    // user's whole edit. Collapsing to the conforming default keeps the save
    // working and fails safe.
    const applied = applyJsonToDraft(
      {
        ...protocolToJson(emptyHostConfigInputV2()),
        paginationTraversal: "everyOtherPage",
        mrtrSupport: "partial",
      } as ReturnType<typeof protocolToJson>,
      emptyHostConfigInputV2(),
    );
    // Assert the save SURVIVED first: `applyJsonToDraft` returns null when it
    // rejects the document, and optional chaining below would read `undefined`
    // for that too — passing on exactly the failure this test exists to rule
    // out.
    expect(applied).not.toBeNull();
    expect(applied!.mcpProfile?.paginationTraversal).toBeUndefined();
    expect(applied!.mcpProfile?.mrtrSupport).toBeUndefined();
  });
});
