import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCopy = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: mockCopy }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
}));

import { ServerAuthSummary } from "../ServerAuthSummary";
import type { ServerAuthReveal } from "../hooks/use-server-auth-reveal";
import type { ServerAuth } from "../server-auth";

const HIDDEN = "••••••••••••";
/** The OAuth token rows' mask, which the bearer token shares. */
const MASK = "****************";

function revealStub(
  overrides: Partial<ServerAuthReveal> = {},
): ServerAuthReveal {
  return {
    canReveal: true,
    headerNames: null,
    revealed: null,
    isRevealing: false,
    error: null,
    reveal: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function renderSummary(
  auth: ServerAuth,
  reveal: ServerAuthReveal = revealStub(),
  onEditInConfig = vi.fn(),
) {
  const view = render(
    <ServerAuthSummary
      auth={auth}
      reveal={reveal}
      serverKey="server-1"
      onEditInConfig={onEditInConfig}
    />,
  );
  return {
    ...view,
    rerenderWith: (nextReveal: ServerAuthReveal) =>
      view.rerender(
        <ServerAuthSummary
          auth={auth}
          reveal={nextReveal}
          serverKey="server-1"
          onEditInConfig={onEditInConfig}
        />,
      ),
  };
}

const bearerLocal: ServerAuth = {
  method: "bearer",
  bearer: { kind: "value", token: "secret-token" },
  headers: null,
};
const bearerSynced: ServerAuth = {
  method: "bearer",
  bearer: { kind: "stored" },
  headers: { kind: "stored" },
};

describe("ServerAuthSummary", () => {
  beforeEach(() => {
    mockCopy.mockClear();
  });

  it("shows a local bearer token like an OAuth token: masked, with show and copy", async () => {
    renderSummary(bearerLocal);

    expect(screen.getByText("Bearer Token")).toBeInTheDocument();
    expect(
      screen.getByText("Sends the saved token in the Authorization header."),
    ).toBeInTheDocument();
    expect(screen.getByText(MASK)).toBeInTheDocument();
    expect(screen.queryByText("secret-token")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reveal Token" }));
    expect(screen.getByText("secret-token")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy Token" }));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith("secret-token"));
  });

  it("decodes a JWT bearer token once it is shown", () => {
    const jwt = [
      btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      btoa(JSON.stringify({ sub: "user-1" })),
      "signature",
    ].join(".");
    renderSummary({
      method: "bearer",
      bearer: { kind: "value", token: jwt },
      headers: null,
    });
    expect(screen.queryByText("View Decoded JWT")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reveal Token" }));
    expect(screen.getByText("View Decoded JWT")).toBeInTheDocument();
  });

  it("shows a synced bearer-only server's token once, not also as a header", () => {
    const { rerenderWith } = renderSummary(bearerSynced);
    // Names still loading: only the token's reveal.
    expect(
      screen.getByRole("button", { name: "Reveal token" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Reveal saved/ }),
    ).not.toBeInTheDocument();

    // Names loaded and the only one was the token's Authorization header.
    rerenderWith(revealStub({ headerNames: [] }));
    expect(
      screen.queryByRole("button", { name: /^Reveal saved/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Custom headers")).not.toBeInTheDocument();
  });

  it("shows the token masked once its reveal lands", async () => {
    const reveal = revealStub({ headerNames: [] });
    const { rerenderWith } = renderSummary(bearerSynced, reveal);

    fireEvent.click(screen.getByRole("button", { name: "Reveal token" }));
    await waitFor(() => expect(reveal.reveal).toHaveBeenCalled());

    rerenderWith(
      revealStub({
        headerNames: [],
        revealed: { bearerToken: "abc", entries: [] },
      }),
    );
    expect(screen.getByText(MASK)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal Token" }));
    expect(screen.getByText("abc")).toBeInTheDocument();
  });

  it("shows the reveal loading state", () => {
    renderSummary(bearerSynced, revealStub({ isRevealing: true }));
    expect(screen.getByRole("button", { name: "Revealing..." })).toBeDisabled();
  });

  it("offers a retry after a failed reveal", () => {
    renderSummary(
      bearerSynced,
      revealStub({
        error: {
          message: "Could not load the saved value. Try again.",
          retryable: true,
        },
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load the saved value. Try again.",
    );
    expect(screen.getByRole("button", { name: "Reveal token" })).toBeEnabled();
  });

  it("shows a refused reveal's reason and offers no retry", () => {
    renderSummary(
      bearerSynced,
      revealStub({
        error: {
          message: "Only someone who can manage this credential can reveal it.",
          retryable: false,
        },
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only someone who can manage this credential can reveal it.",
    );
    expect(screen.getByRole("button", { name: "Reveal token" })).toBeDisabled();
  });

  it("lists hidden headers by name and uncovers only the clicked row", async () => {
    const auth: ServerAuth = {
      method: "none",
      bearer: null,
      headers: { kind: "stored" },
    };
    const reveal = revealStub({ headerNames: ["X-API-Key", "X-Tenant"] });
    const { rerenderWith } = renderSummary(auth, reveal);

    expect(
      screen.getByText("Sends only the custom headers below."),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("X-API-Key")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Copy value/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Show value for X-Tenant" }),
    );
    expect(reveal.reveal).toHaveBeenCalled();

    rerenderWith(
      revealStub({
        headerNames: ["X-API-Key", "X-Tenant"],
        revealed: {
          bearerToken: undefined,
          entries: [
            ["X-API-Key", "key-1"],
            ["X-Tenant", "acme"],
          ],
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Header 2 value")).toHaveValue("acme"),
    );
    expect(screen.getByLabelText("Header 1 value")).toHaveValue(HIDDEN);
    expect(screen.getAllByRole("button", { name: /^Copy value/ })).toHaveLength(
      2,
    );
  });

  it("shows one field for hidden headers whose names aren't loaded", () => {
    renderSummary(
      { method: "none", bearer: null, headers: { kind: "stored" } },
      revealStub(),
    );
    expect(
      screen.getByRole("button", { name: "Reveal saved headers" }),
    ).toBeInTheDocument();
  });

  it("lists local headers next to a local token", () => {
    renderSummary({
      method: "bearer",
      bearer: { kind: "value", token: "t" },
      headers: { kind: "values", entries: [["X-Tenant", "acme"]] },
    });
    expect(screen.getByText("Custom headers")).toBeInTheDocument();
    expect(screen.getByDisplayValue("X-Tenant")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Authorization")).not.toBeInTheDocument();
  });

  it.each([
    ["none", "No Authentication", "Sends requests without credentials."],
    [
      "auto",
      "Auto",
      "Tries without credentials first, then OAuth if the server asks for it.",
    ],
    ["oauth", "OAuth", "Accounts, tokens and the last OAuth trace are below."],
    [
      "xaa",
      "Cross-App Access (XAA)",
      "Gets access tokens from your identity provider when MCPJam connects.",
    ],
  ] as const)(
    "explains the %s method without credential rows",
    (method, label, note) => {
      renderSummary({ method, bearer: null, headers: null });
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(note)).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    },
  );

  it("says why saved values can't be shown for a server outside a project", () => {
    renderSummary(bearerSynced, revealStub({ canReveal: false }));
    expect(
      screen.getByText(
        "Save this server to a project to see its saved values.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal token" })).toBeDisabled();
  });

  it("switches to Config from Edit in Config", () => {
    const onEditInConfig = vi.fn();
    renderSummary(bearerLocal, revealStub(), onEditInConfig);
    fireEvent.click(screen.getByRole("button", { name: "Edit in Config" }));
    expect(onEditInConfig).toHaveBeenCalledTimes(1);
  });
});
