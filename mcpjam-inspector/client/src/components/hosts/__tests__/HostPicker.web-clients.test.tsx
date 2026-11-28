import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The create-suite dialog's Clients section and every other `HostPicker`
 * follow the same rule as the chat's client selector: Claude web and ChatGPT
 * web stay out while their flag is off.
 */
const webClients = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useWebClientsEnabled", () => ({
  useWebClientsEnabled: () => webClients.enabled,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

const host = (hostId: string, name: string, runtime?: string) => ({
  hostId,
  name,
  runtime,
  hostConfigId: `cfg-${hostId}`,
  modelId: "m",
  serverCount: 0,
  createdAt: 1,
  updatedAt: 1,
});

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      host("host-claude", "Claude"),
      host("host-web", "ChatGPT web", "chatgpt-web"),
    ],
    isLoading: false,
  }),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { HostPicker } from "../HostPicker";

function renderPicker(value: string | null) {
  return render(
    <HostPicker
      projectId="proj-1"
      value={value}
      onChange={vi.fn()}
      location="eval_runner"
      includeNone={false}
      placeholder="Choose a client to attach"
    />,
  );
}

async function optionNames() {
  await userEvent.click(screen.getByRole("combobox"));
  const options = await screen.findAllByRole("option");
  return options.map((option) => option.textContent);
}

describe("HostPicker web clients", () => {
  afterEach(() => {
    webClients.enabled = false;
  });

  it("offers ChatGPT web only while its flag is on", async () => {
    webClients.enabled = false;
    const { unmount } = renderPicker(null);
    expect(await optionNames()).toEqual(["Claude"]);
    unmount();

    webClients.enabled = true;
    renderPicker(null);
    expect(await optionNames()).toEqual(["Claude", "ChatGPT web"]);
  });

  it("still names a ChatGPT web client already chosen, with its flag off", () => {
    webClients.enabled = false;
    renderPicker("host-web");
    expect(screen.getByRole("combobox")).toHaveTextContent("ChatGPT web");
  });
});
