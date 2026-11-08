import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectedServer,
  createHttpServerConfig,
  createServerConfig,
} from "@/test/factories";
import type { ConformanceSelection } from "@/hooks/use-conformance-run";
import { ConformanceSetup } from "../ConformanceSetup";
import { RUN_LABEL } from "../ConformancePageChrome";

const hint = vi.hoisted(() => ({ showOAuthCallbackNotice: vi.fn() }));
vi.mock("../oauth-callback-hint", () => hint);
vi.mock("@/lib/apis/conformance-connection-api", () => ({
  checkConformanceConnection: vi.fn(async () => ({
    status: "ready",
    protocolVersion: "2025-11-25",
  })),
}));
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(async () => ({ tools: [] })),
}));

async function openChecks(
  config: ReturnType<typeof createServerConfig>,
  initialSelection?: ConformanceSelection,
) {
  render(
    <ConformanceSetup
      servers={[createConnectedServer({ name: "alpha", config })]}
      initialServerName="alpha"
      initialVersionPin="2025-11-25"
      initialSelection={initialSelection}
      onRun={vi.fn()}
      onCancel={vi.fn()}
      onConnectServer={vi.fn(async () => "ready" as const)}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("button", { name: RUN_LABEL });
}

describe("conformance setup OAuth callback notice", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the notice when the checks open with OAuth picked", async () => {
    await openChecks(createHttpServerConfig("https://alpha.test/mcp"));

    expect(hint.showOAuthCallbackNotice).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when OAuth is not picked", async () => {
    await openChecks(createHttpServerConfig("https://alpha.test/mcp"), {
      oauth: false,
    });

    expect(hint.showOAuthCallbackNotice).not.toHaveBeenCalled();
  });

  it("stays quiet for a stdio server, which has no OAuth", async () => {
    await openChecks(createServerConfig());

    expect(hint.showOAuthCallbackNotice).not.toHaveBeenCalled();
  });
});
