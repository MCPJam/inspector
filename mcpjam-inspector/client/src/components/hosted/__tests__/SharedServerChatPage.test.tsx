import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { SharedServerChatPage } from "../SharedServerChatPage";
import {
  clearSharedServerSession,
  writeSharedServerSession,
} from "@/lib/shared-server-session";

const mockResolveShareForViewer = vi.fn();
const mockGetAccessToken = vi.fn();
const mockClipboardWriteText = vi.fn();
const mockGetStoredTokens = vi.fn();
const mockInitiateOAuth = vi.fn(async () => ({ success: false }));
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  useMutation: () => mockResolveShareForViewer,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
  }),
}));

vi.mock("@/hooks/hosted/use-hosted-api-context", () => ({
  useHostedApiContext: vi.fn(),
}));

vi.mock("@/components/ChatTabV2", () => ({
  ChatTabV2: () => <div data-testid="shared-chat-tab" />,
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  getStoredTokens: (...args: unknown[]) => mockGetStoredTokens(...args),
  initiateOAuth: (...args: unknown[]) => mockInitiateOAuth(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

describe("SharedServerChatPage", () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function createSharePayload(
    overrides: Partial<{
      workspaceId: string;
      serverId: string;
      serverName: string;
      mode: "invited_only" | "workspace";
      viewerIsWorkspaceMember: boolean;
      useOAuth: boolean;
      serverUrl: string | null;
      clientId: string | null;
      oauthScopes: string[] | null;
    }> = {},
  ) {
    return {
      workspaceId: "ws_1",
      serverId: "srv_1",
      serverName: "Server One",
      mode: "invited_only" as const,
      viewerIsWorkspaceMember: false,
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
      ...overrides,
    };
  }

  function createFetchResponse(
    body: unknown,
    overrides: Partial<{
      ok: boolean;
      status: number;
      statusText: string;
    }> = {},
  ) {
    return {
      ok: overrides.ok ?? true,
      status: overrides.status ?? 200,
      statusText: overrides.statusText ?? "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    } as Response;
  }

  beforeEach(() => {
    clearSharedServerSession();
    mockResolveShareForViewer.mockReset();
    mockGetAccessToken.mockReset();
    mockClipboardWriteText.mockReset();
    mockGetStoredTokens.mockReset();
    mockInitiateOAuth.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();

    mockGetAccessToken.mockResolvedValue("workos-token");
    mockGetStoredTokens.mockReturnValue(null);
    mockInitiateOAuth.mockResolvedValue({ success: false });
    mockClipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockClipboardWriteText,
      },
    });
  });

  it("copies the full shared path link from the header", async () => {
    writeSharedServerSession({
      token: "token 123",
      payload: createSharePayload(),
    });

    render(<SharedServerChatPage />);

    const copyButton = await screen.findByRole("button", { name: "Copy link" });
    await userEvent.click(copyButton);

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith(
        `${window.location.origin}/shared/server-one/token%20123`,
      );
    });
    expect(toastSuccess).toHaveBeenCalledWith("Share link copied");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("ignores a stale validation network error after the effect is cancelled", async () => {
    const deferredValidate = createDeferred<Response>();
    vi.mocked(global.fetch).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "/api/web/servers/validate") {
          return deferredValidate.promise;
        }

        return createFetchResponse({});
      },
    );

    mockGetStoredTokens.mockImplementation((serverName: string) => {
      if (serverName === "OAuth One") {
        return { access_token: "expired-token" };
      }
      return null;
    });

    writeSharedServerSession({
      token: "token-one",
      payload: createSharePayload({
        workspaceId: "ws_oauth_1",
        serverId: "srv_oauth_1",
        serverName: "OAuth One",
        useOAuth: true,
        serverUrl: "https://oauth-one.example.com/mcp",
      }),
    });

    const { rerender } = render(<SharedServerChatPage />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/web/servers/validate",
        expect.any(Object),
      );
    });

    mockResolveShareForViewer.mockResolvedValueOnce(
      createSharePayload({
        workspaceId: "ws_oauth_2",
        serverId: "srv_oauth_2",
        serverName: "OAuth Two",
        useOAuth: true,
        serverUrl: "https://oauth-two.example.com/mcp",
      }),
    );

    rerender(<SharedServerChatPage pathToken="token-two" />);

    expect(
      await screen.findByRole("heading", { name: "Authorization Required" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("shared-chat-tab")).not.toBeInTheDocument();

    await act(async () => {
      deferredValidate.reject(new Error("validation request failed"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Authorization Required" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("shared-chat-tab")).not.toBeInTheDocument();
  });
});
