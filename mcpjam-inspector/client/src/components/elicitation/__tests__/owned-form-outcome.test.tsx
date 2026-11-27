import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  mutate: vi.fn(),
  action: vi.fn(),
  post: vi.fn(),
  track: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: state.mutate, action: state.action }),
  useQuery: (name: string) =>
    name === "users:getCurrentUser" ? { _id: "owned-user" } : state.rows,
}));
vi.mock("@/lib/apis/web/base", () => ({ webPost: state.post }));
vi.mock("@/lib/analytics", () => ({ track: state.track }));
import { OwnedPluginFormHost } from "../OwnedPluginFormHost";
import { __resetComposerFormStore } from "../composer-form-store";

const schema = {
  type: "object",
  required: ["note"],
  properties: { note: { type: "string", minLength: 2 } },
};
const outcomes = () =>
  state.track.mock.calls
    .filter((call) => call[0] === "extension_operation_completed")
    .map((call) => call[1]);

describe("owned form response outcome", () => {
  beforeEach(() => {
    state.rows = [
      {
        rendezvousId: "owned-request",
        serverId: "owned-server",
        mode: "form",
        message: "Choose disposable parts",
        requestedSchema: schema,
        expiresAt: Date.now() + 60000,
        formDialect: "openai",
        pluginWorkspaceId: "workspace",
      },
    ];
    state.action.mockReset().mockResolvedValue(JSON.stringify(schema));
    state.mutate.mockReset().mockResolvedValue({ ok: true });
    state.post
      .mockReset()
      .mockResolvedValue({ ok: true, storageId: "owned-receipt" });
    state.track.mockClear();
  });
  afterEach(() => {
    cleanup();
    __resetComposerFormStore();
  });

  async function answer(button: string) {
    render(<OwnedPluginFormHost projectId="project" workspaceId="workspace" />);
    fireEvent.change(await screen.findByLabelText(/note/i), {
      target: { value: "PRIVATE_ANSWER" },
    });
    fireEvent.click(screen.getByRole("button", { name: button, exact: true }));
    await waitFor(() => expect(outcomes()).toHaveLength(1));
  }

  it("records one success when the answer is delivered", async () => {
    await answer("Accept");
    expect(outcomes()).toEqual([
      {
        operation: "form_response",
        host_profile: "unknown",
        outcome: "success",
        error_code: "none",
        location: "host_workspace",
      },
    ]);
    expect(JSON.stringify(state.track.mock.calls)).not.toContain("PRIVATE");
  });

  it("records a decline as declined, not a failure", async () => {
    await answer("Decline");
    expect(outcomes()).toEqual([
      expect.objectContaining({ outcome: "declined", error_code: "none" }),
    ]);
  });

  it("records one failure when the server refuses the answer", async () => {
    state.mutate.mockResolvedValue({ ok: false, reason: "replica" });
    await answer("Accept");
    expect(outcomes()).toEqual([
      expect.objectContaining({ outcome: "failure", error_code: "other" }),
    ]);
  });
});
