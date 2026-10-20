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
      <div data-testid="listens">
        {String(draft.mcpProfile?.toolListChanged?.listens ?? "<undefined>")}
      </div>
      <div data-testid="refetches">
        {String(draft.mcpProfile?.toolListChanged?.refetches ?? "<undefined>")}
      </div>
      <div data-testid="auth">
        {JSON.stringify({
          unauthorizedChallenge: draft.mcpProfile?.unauthorizedChallenge,
          unauthorizedChallengeTrigger:
            draft.mcpProfile?.unauthorizedChallengeTrigger,
          toolResultAuthChallenge: draft.mcpProfile?.toolResultAuthChallenge,
          toolResultAuthChallengeTrigger:
            draft.mcpProfile?.toolResultAuthChallengeTrigger,
        })}
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

describe("ProtocolTab tool list changed controls", () => {
  const listensSwitch = () =>
    screen.getByRole("switch", { name: "Opens notification channel" });
  const refetchesSwitch = () =>
    screen.getByRole("switch", {
      name: "Re-fetches tools after the notification",
    });

  it("renders conforming defaults with nothing stored", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);
    expect(listensSwitch()).toBeChecked();
    expect(refetchesSwitch()).toBeChecked();
    expect(screen.getByTestId("listens")).toHaveTextContent("<undefined>");
    expect(screen.getByTestId("profile")).toHaveTextContent("<no-profile>");
  });

  it("stores false when a switch is turned off", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);
    await user.click(listensSwitch());
    expect(screen.getByTestId("listens")).toHaveTextContent("false");
  });

  it("writes ABSENCE when switched back on, collapsing the profile", async () => {
    // The whole point of the knob: re-enabling must leave no trace, or a host
    // that merely visited this tab mints a new canonical hash.
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);
    await user.click(listensSwitch());
    expect(screen.getByTestId("profile")).toHaveTextContent("profile");
    await user.click(listensSwitch());
    expect(screen.getByTestId("listens")).toHaveTextContent("<undefined>");
    expect(screen.getByTestId("profile")).toHaveTextContent("<no-profile>");
  });

  it("keeps re-fetch editable once the channel is closed", async () => {
    // The two are independent. This used to disable re-fetch on the theory
    // that nothing can arrive without a channel; the 2026-08-26 Copilot
    // capture disproved it — the server published `list_changed` on an open
    // tools/call response stream and Copilot re-fetched, having never opened
    // the standalone channel. closed + re-fetches is a real, probed pair, so
    // the UI has to be able to express it.
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);
    await user.click(listensSwitch());
    expect(refetchesSwitch()).toBeEnabled();

    await user.click(refetchesSwitch());
    expect(screen.getByTestId("listens")).toHaveTextContent("false");
    expect(screen.getByTestId("refetches")).toHaveTextContent("false");
  });

  it("round-trips through the JSON document", () => {
    const draft = {
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1 as const,
        toolListChanged: { listens: false },
      },
    };
    const doc = protocolToJson(draft);
    expect(doc.toolListChanged).toEqual({ listens: false });

    const applied = applyJsonToDraft(doc, emptyHostConfigInputV2());
    expect(applied).not.toBeNull();
    expect(applied?.mcpProfile?.toolListChanged).toEqual({ listens: false });
  });

  it("drops non-boolean leaves from the document", () => {
    const applied = applyJsonToDraft(
      {
        ...protocolToJson(emptyHostConfigInputV2()),
        toolListChanged: { listens: "no", refetches: false },
      } as unknown as ReturnType<typeof protocolToJson>,
      emptyHostConfigInputV2(),
    );
    // Assert the save SURVIVED first — a rejected document also reads as
    // `undefined` below, which would pass for the wrong reason.
    expect(applied).not.toBeNull();
    // Fail-closed: an unreadable leaf reads as conforming, not as degraded.
    expect(applied?.mcpProfile?.toolListChanged).toEqual({ refetches: false });
  });
});

describe("ProtocolTab mid-session sign-in controls", () => {
  const unauthorizedCombo = () =>
    screen.getByRole("combobox", { name: "On HTTP 401" });
  const unauthorizedTriggerCombo = () =>
    screen.getByRole("combobox", { name: "HTTP 401 trigger" });
  const toolResultCombo = () =>
    screen.getByRole("combobox", { name: "On tool-result _meta challenge" });
  const toolResultTriggerCombo = () =>
    screen.getByRole("combobox", { name: "Tool-result _meta trigger" });
  const stored = () =>
    JSON.parse(screen.getByTestId("auth").textContent ?? "{}") as Record<
      string,
      string | undefined
    >;

  it("shows the SDK defaults for a host that never configured them", () => {
    render(<Harness initial={emptyHostConfigInputV2()} />);
    // The two families default differently on purpose: a 401 is in the MCP
    // spec, the `_meta` challenge is not.
    expect(unauthorizedCombo()).toHaveTextContent(
      "Prompt to sign in (default)",
    );
    expect(unauthorizedTriggerCombo()).toHaveTextContent("Any 401 (default)");
    expect(toolResultCombo()).toHaveTextContent("Pass through (default)");
    expect(toolResultTriggerCombo()).toHaveTextContent(
      "oauth2 + error and error_description (default)",
    );
    expect(stored()).toEqual({});
    expect(screen.getByTestId("profile").textContent).toBe("<no-profile>");
  });

  it("stores a non-default value when the user picks it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyHostConfigInputV2()} />);

    await user.click(unauthorizedCombo());
    await user.click(screen.getByRole("option", { name: "Notify" }));
    await user.click(unauthorizedTriggerCombo());
    await user.click(
      screen.getByRole("option", { name: "Needs WWW-Authenticate: Bearer" }),
    );
    await user.click(toolResultCombo());
    await user.click(screen.getByRole("option", { name: "Prompt to sign in" }));
    await user.click(toolResultTriggerCombo());
    await user.click(
      screen.getByRole("option", { name: "Tool declares oauth2" }),
    );

    expect(stored()).toEqual({
      unauthorizedChallenge: "notify",
      unauthorizedChallengeTrigger: "bearer-header",
      toolResultAuthChallenge: "prompt",
      toolResultAuthChallengeTrigger: "oauth2-scheme",
    });
  });

  it("writes ABSENCE when the user picks the default back", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...emptyHostConfigInputV2(),
          mcpProfile: {
            profileVersion: 1,
            unauthorizedChallenge: "notify",
            toolResultAuthChallenge: "prompt",
          },
        }}
      />,
    );

    await user.click(unauthorizedCombo());
    await user.click(
      screen.getByRole("option", { name: "Prompt to sign in (default)" }),
    );
    // The `_meta` family is still set, so the profile survives.
    expect(stored()).toEqual({ toolResultAuthChallenge: "prompt" });
    expect(screen.getByTestId("profile").textContent).toBe("profile");

    await user.click(toolResultCombo());
    await user.click(
      screen.getByRole("option", { name: "Pass through (default)" }),
    );
    expect(stored()).toEqual({});
    // Nothing left in the profile, so it collapses and hashes like a host
    // that never opened this tab.
    expect(screen.getByTestId("profile").textContent).toBe("<no-profile>");
  });

  it("says a trigger is inert while its action passes through", () => {
    render(
      <Harness
        initial={{
          ...emptyHostConfigInputV2(),
          mcpProfile: {
            profileVersion: 1,
            unauthorizedChallenge: "passthrough",
          },
        }}
      />,
    );
    // Both triggers are inert here: the 401 action is stored as Pass through
    // and the `_meta` action defaults to it. They stay editable, so a stored
    // trigger is never stranded.
    expect(
      screen.getAllByText("No effect while the action above is Pass through."),
    ).toHaveLength(2);
    expect(unauthorizedTriggerCombo()).toBeEnabled();
    expect(toolResultTriggerCombo()).toBeEnabled();
  });

  it("disables every control when read-only", () => {
    render(
      <ProtocolTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={() => {}}
        attention={[]}
        readOnly
      />,
    );
    for (const combo of [
      unauthorizedCombo(),
      unauthorizedTriggerCombo(),
      toolResultCombo(),
      toolResultTriggerCombo(),
    ]) {
      expect(combo).toBeDisabled();
    }
  });
});

describe("ProtocolTab JSON round-trip for the sign-in knobs", () => {
  it("omits the keys entirely when unset", () => {
    const doc = protocolToJson(emptyHostConfigInputV2());
    expect("unauthorizedChallenge" in doc).toBe(false);
    expect("unauthorizedChallengeTrigger" in doc).toBe(false);
    expect("toolResultAuthChallenge" in doc).toBe(false);
    expect("toolResultAuthChallengeTrigger" in doc).toBe(false);
  });

  it("surfaces and re-applies stored values", () => {
    const draft: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1,
        unauthorizedChallenge: "notify",
        unauthorizedChallengeTrigger: "resource-metadata",
        toolResultAuthChallenge: "prompt",
        toolResultAuthChallengeTrigger: "any",
      },
    };
    const doc = protocolToJson(draft);
    expect(doc.unauthorizedChallenge).toBe("notify");
    expect(doc.unauthorizedChallengeTrigger).toBe("resource-metadata");
    expect(doc.toolResultAuthChallenge).toBe("prompt");
    expect(doc.toolResultAuthChallengeTrigger).toBe("any");

    const applied = applyJsonToDraft(doc, emptyHostConfigInputV2());
    expect(applied).not.toBeNull();
    expect(applied!.mcpProfile).toMatchObject({
      unauthorizedChallenge: "notify",
      unauthorizedChallengeTrigger: "resource-metadata",
      toolResultAuthChallenge: "prompt",
      toolResultAuthChallengeTrigger: "any",
    });
  });

  it("clears a knob deleted from the document", () => {
    // Parsed-authoritative, like the sibling knobs: deleting the key in the
    // JSON must clear it rather than keep the previous value.
    const prev: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: { profileVersion: 1, toolResultAuthChallenge: "prompt" },
    };
    const applied = applyJsonToDraft(
      protocolToJson(emptyHostConfigInputV2()),
      prev,
    );
    expect(applied).not.toBeNull();
    expect(applied!.mcpProfile).toBeUndefined();
  });

  it("collapses unknown literals to undefined instead of failing the save", () => {
    const applied = applyJsonToDraft(
      {
        ...protocolToJson(emptyHostConfigInputV2()),
        unauthorizedChallenge: "redirect",
        unauthorizedChallengeTrigger: "bearer",
        toolResultAuthChallenge: true,
        toolResultAuthChallengeTrigger: "oauth2",
      } as unknown as ReturnType<typeof protocolToJson>,
      emptyHostConfigInputV2(),
    );
    // Assert the save SURVIVED first: a rejected document also reads as
    // `undefined` below.
    expect(applied).not.toBeNull();
    expect(applied!.mcpProfile).toBeUndefined();
  });
});
