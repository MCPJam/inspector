import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingInviteDialog,
  consumePendingInviteDialog,
  markPendingInviteDialog,
  PENDING_INVITE_DIALOG_TTL_MS,
} from "../pending-invite-dialog";

describe("pending-invite-dialog", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("consumes a fresh marker exactly once", () => {
    markPendingInviteDialog();
    expect(consumePendingInviteDialog()).toBe(true);
    // Read and clear together: a consumed marker must not reopen the dialog
    // on the NEXT sign-in this tab performs.
    expect(consumePendingInviteDialog()).toBe(false);
  });

  it("returns false when nothing was stored", () => {
    expect(consumePendingInviteDialog()).toBe(false);
  });

  it("expires markers older than the TTL, and still clears them", () => {
    markPendingInviteDialog(1_000);
    expect(
      consumePendingInviteDialog(1_000 + PENDING_INVITE_DIALOG_TTL_MS + 1),
    ).toBe(false);
    expect(consumePendingInviteDialog()).toBe(false);
  });

  it("clearPendingInviteDialog removes a pending marker", () => {
    markPendingInviteDialog();
    clearPendingInviteDialog();
    expect(consumePendingInviteDialog()).toBe(false);
  });
});
