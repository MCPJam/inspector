import { describe, expect, it } from "vitest";
import {
  disambiguateLabels,
  environmentDetailLine,
  environmentImageLabel,
  environmentLabel,
  environmentOrigin,
  isAdhocEnvironment,
  isNamedEnvironment,
  trimOrUndefined,
  type EnvironmentLabelContext,
  type EnvironmentLabelRow,
} from "@/lib/environment-label";

const HOSTS: Record<string, string> = {
  h_claude: "Claude",
  h_chatgpt: "ChatGPT",
};

const ctx: EnvironmentLabelContext = {
  hostName: (hostId) => HOSTS[hostId],
  imageName: (imageId) => (imageId === "img_ok" ? "ubuntu-24" : undefined),
  computersEnabled: true,
};

function row(
  overrides: Partial<EnvironmentLabelRow> = {}
): EnvironmentLabelRow {
  return {
    environmentId: "env_1",
    hostId: "h_claude",
    ...overrides,
  };
}

describe("environmentOrigin", () => {
  it("uses the explicit origin when the backend sends one", () => {
    expect(environmentOrigin(row({ origin: "adhoc", name: "leftover" }))).toBe(
      "adhoc"
    );
    expect(environmentOrigin(row({ origin: "named" }))).toBe("named");
  });

  // Deploy skew: a backend that predates the split omits `origin` entirely, and
  // every row it returns is one a human named.
  it("reads a named row from a pre-origin backend as named", () => {
    expect(environmentOrigin(row({ name: "Billing" }))).toBe("named");
    expect(isNamedEnvironment(row({ name: "Billing" }))).toBe(true);
  });

  it("reads a nameless row with no origin as adhoc rather than blank", () => {
    expect(environmentOrigin(row())).toBe("adhoc");
    expect(isAdhocEnvironment(row())).toBe(true);
  });

  // A whitespace-only name is not a name.
  it("treats a blank name as absent", () => {
    expect(environmentOrigin(row({ name: "   " }))).toBe("adhoc");
  });
});

describe("environmentLabel", () => {
  it("labels a named row with its name", () => {
    expect(environmentLabel(row({ name: "Billing" }), ctx)).toBe("Billing");
  });

  it("labels an adhoc row with its client name", () => {
    expect(environmentLabel(row({ origin: "adhoc" }), ctx)).toBe("Claude");
  });

  it("appends a model segment on an ad-hoc row that carries a model override", () => {
    expect(
      environmentLabel(row({ origin: "adhoc", modelId: "google/gemini-2.5-flash" }), {
        ...ctx,
        modelName: (id) =>
          id === "google/gemini-2.5-flash" ? "Gemini 2.5 Flash" : undefined,
      })
    ).toBe("Claude · Gemini 2.5 Flash");
  });

  it("falls back to the model id tail when no catalog name is supplied", () => {
    expect(
      environmentLabel(row({ origin: "adhoc", modelId: "anthropic/claude-haiku-4.5" }), ctx)
    ).toBe("Claude · claude-haiku-4.5");
  });

  // The `.trim() ||` vs `??` distinction. An empty name must fall THROUGH to the
  // client name; `??` would pass it straight to the UI as a blank cell.
  it("falls through an empty-string name to the client name", () => {
    expect(environmentLabel(row({ name: "" }), ctx)).toBe("Claude");
  });

  it("falls back when the host is gone from the project", () => {
    expect(environmentLabel(row({ hostId: "h_deleted" }), ctx)).toBe(
      "Unknown client"
    );
  });
});

describe("environmentDetailLine", () => {
  it("describes the client's own servers with zero pins", () => {
    expect(environmentDetailLine(row(), ctx)).toBe(
      "Client's own servers · 0 skill pins · 0 plugin pins"
    );
  });

  it("singularizes a single pin and names an attached group", () => {
    const line = environmentDetailLine(
      row({
        serverAttachmentId: "sa_1",
        skillSelection: { mode: "explicit", skillIds: ["s1"] },
        pluginVersionIds: ["pv1"],
      }),
      ctx
    );
    expect(line).toBe("Server group attached · 1 skill pin · 1 plugin pin");
  });

  it("appends the image name when one is pinned", () => {
    const line = environmentDetailLine(
      row({ computerEnvironmentId: "img_ok" }),
      ctx
    );
    expect(line.endsWith(" · ubuntu-24")).toBe(true);
  });
});

describe("environmentImageLabel", () => {
  // Absence is semantic — an unpinned row means "provider default image" and
  // must render nothing rather than a filler label.
  it("returns undefined when nothing is pinned", () => {
    expect(environmentImageLabel(row(), ctx)).toBeUndefined();
  });

  it("returns undefined when the computers flag is off, even if pinned", () => {
    expect(
      environmentImageLabel(row({ computerEnvironmentId: "img_ok" }), {
        ...ctx,
        computersEnabled: false,
      })
    ).toBeUndefined();
  });

  // A deleted or not-yet-loaded image degrades to a truncated id, never a blank.
  it("degrades an unresolvable image to a truncated id", () => {
    expect(
      environmentImageLabel(
        row({ computerEnvironmentId: "img_gone_1234" }),
        ctx
      )
    ).toBe("image img_gone…");
  });
});

describe("disambiguateLabels", () => {
  it("leaves unique labels untouched", () => {
    const out = disambiguateLabels([{ label: "Claude" }, { label: "ChatGPT" }]);
    expect(out.map((o) => o.label)).toEqual(["Claude", "ChatGPT"]);
  });

  // Adhoc rows label by client name, so this is the COMMON case, not an edge.
  it("suffixes colliding labels in stable order", () => {
    const out = disambiguateLabels([
      { label: "Claude" },
      { label: "ChatGPT" },
      { label: "Claude" },
      { label: "Claude" },
    ]);
    expect(out.map((o) => o.label)).toEqual([
      "Claude #1",
      "ChatGPT",
      "Claude #2",
      "Claude #3",
    ]);
  });

  it("preserves the other fields on each item", () => {
    const out = disambiguateLabels([
      { label: "Claude", environmentId: "a" },
      { label: "Claude", environmentId: "b" },
    ]);
    expect(out.map((o) => o.environmentId)).toEqual(["a", "b"]);
  });
});

describe("trimOrUndefined", () => {
  it.each([
    ["Billing", "Billing"],
    ["  Billing  ", "Billing"],
    ["", undefined],
    ["   ", undefined],
    [undefined, undefined],
  ])("%o → %o", (input, expected) => {
    expect(trimOrUndefined(input as string | undefined)).toBe(expected);
  });
});

describe("environmentLabel without a client-name lookup", () => {
  // Surfaces that never LIST ad-hoc rows (the shared picker) omit the lookup
  // rather than pay two project-wide queries to label a rare selected row.
  it("labels an adhoc row generically when no hostName is supplied", () => {
    expect(environmentLabel(row({ origin: "adhoc" }), {})).toBe(
      "Automatic environment"
    );
    expect(environmentLabel(row({ origin: "adhoc" }))).toBe(
      "Automatic environment"
    );
  });

  // "Unknown client" specifically means "the host was deleted" — a claim we
  // cannot make without a lookup, so it must not leak into the no-context path.
  it("does not claim the client is unknown when it simply wasn't looked up", () => {
    expect(environmentLabel(row({ origin: "adhoc" }), {})).not.toBe(
      "Unknown client"
    );
  });

  it("still prefers a real name over the generic label", () => {
    expect(environmentLabel(row({ name: "Billing" }), {})).toBe("Billing");
  });
});
