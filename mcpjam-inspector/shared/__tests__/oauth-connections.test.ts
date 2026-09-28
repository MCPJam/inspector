import { describe, expect, it } from "vitest";
import {
  connectionLabel,
  connectionLabels,
  type OAuthConnection,
} from "../oauth-connections";

const make = (
  id: string,
  profile?: OAuthConnection["profile"],
  label?: string,
): OAuthConnection => ({
  connectionId: id,
  isDefault: false,
  ...(label ? { label } : {}),
  ...(profile ? { profile } : {}),
});

describe("connectionLabels", () => {
  it("leaves distinct labels alone", () => {
    expect(
      connectionLabels([
        make("a", { id: "1", email: "work@example.com" }),
        make("b", { id: "2", email: "home@example.com" }),
      ]),
    ).toEqual(["work@example.com", "home@example.com"]);
  });

  it("qualifies two accounts that share an email — the case this exists for", () => {
    // Both labels used to read `same@example.com`, leaving the model to choose
    // between two identical strings and an opaque id.
    expect(
      connectionLabels([
        make("a", { id: "1", email: "same@example.com", name: "Acme Corp" }),
        make("b", { id: "2", email: "same@example.com", name: "Side Project" }),
      ]),
    ).toEqual([
      "same@example.com (Acme Corp)",
      "same@example.com (Side Project)",
    ]);
  });

  it("falls through to the nickname, then the id, and never repeats itself", () => {
    const labels = connectionLabels([
      make("aaaaaa111111", { id: "1", email: "s@e.com", nickname: "Work" }),
      make("bbbbbb222222", { id: "2", email: "s@e.com", nickname: "Work" }),
      make("cccccc333333", { id: "3", email: "s@e.com" }),
    ]);
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]).toBe("s@e.com (Work)");
    expect(labels[1]).toContain("222222");
  });

  it("keeps a user's own name for the account", () => {
    expect(
      connectionLabels([
        make("a", { id: "1", email: "same@example.com" }, "Personal"),
        make("b", { id: "2", email: "same@example.com" }, "Team"),
      ]),
    ).toEqual(["Personal", "Team"]);
  });

  it("still names an account with no profile at all", () => {
    expect(connectionLabel(make("a"), 0)).toBe("Account 1");
    expect(new Set(connectionLabels([make("a"), make("b")])).size).toBe(2);
  });
});
