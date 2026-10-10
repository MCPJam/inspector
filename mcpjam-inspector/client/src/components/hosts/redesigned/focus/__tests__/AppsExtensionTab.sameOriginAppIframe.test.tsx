import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { AppsExtensionTab } from "../AppsExtensionTab";

function renderTab(initial?: Partial<HostConfigInputV2>) {
  const draftRef: { current: HostConfigInputV2 } = {
    current: emptyHostConfigInputV2({ hostStyle: "claude", ...initial }),
  };
  function Harness({ initialDraft }: { initialDraft: HostConfigInputV2 }) {
    const [draft, setDraft] = useState<HostConfigInputV2>(initialDraft);
    draftRef.current = draft;
    return (
      <AppsExtensionTab
        draft={draft}
        onDraftChange={(updater) =>
          setDraft((prev) => {
            const next = updater(prev);
            draftRef.current = next;
            return next;
          })
        }
        attention={[]}
      />
    );
  }
  render(<Harness initialDraft={draftRef.current} />);
  return { draftRef };
}

const toggle = () =>
  within(screen.getByTestId("same-origin-app-iframe-card")).getByRole(
    "switch",
    { name: "Same-origin app iframe" },
  );

describe("AppsExtensionTab — same-origin app iframe", () => {
  it("is on when unset, writes an explicit off, and collapses back to unset", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderTab();
    expect(toggle()).toBeChecked();
    expect(draftRef.current.mcpProfile).toBeUndefined();

    await user.click(toggle());
    expect(
      draftRef.current.mcpProfile?.apps?.sandbox?.sameOriginAppIframe,
    ).toBe(false);
    expect(toggle()).not.toBeChecked();

    // On again must not leave `{ profileVersion: 1 }` behind: that hashes
    // differently and would mint a new config row for a no-op.
    await user.click(toggle());
    expect(draftRef.current.mcpProfile).toBeUndefined();
  });

  it("shows off for a client measured like claude.ai", () => {
    renderTab({
      mcpProfile: {
        profileVersion: 1,
        apps: { sandbox: { sameOriginAppIframe: false } },
      },
    });
    expect(toggle()).not.toBeChecked();
  });
});
