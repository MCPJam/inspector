import { beforeEach, describe, expect, it } from "vitest";
import {
  buildScenarioLink,
  clearScenarioSession,
  clearScenarioSignInReturnPath,
  extractScenarioTokenFromPath,
  hasActiveScenarioSession,
  readScenarioSurfaceFromUrl,
  readScenarioSession,
  readScenarioSignInReturnPath,
  SCENARIO_SESSION_STORAGE_KEY,
  SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  normalizeScenarioSession,
  writeScenarioSession,
  writeScenarioSignInReturnPath,
} from "../scenario-session";

describe("scenario-session", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearScenarioSession();
    clearScenarioSignInReturnPath();
  });

  it("ignores the retired /chatbox/<slug>/<token> paths", () => {
    expect(extractScenarioTokenFromPath("/chatbox/demo/abc123")).toBeNull();
    expect(extractScenarioTokenFromPath("/chatbox/onlyone")).toBeNull();
    expect(extractScenarioTokenFromPath("/settings")).toBeNull();
  });

  it("extracts token from /user-testing/<slug>/<token> paths", () => {
    expect(extractScenarioTokenFromPath("/user-testing/demo/abc123")).toBe(
      "abc123"
    );
    // The scenario screen lives one segment shorter, and must NOT be read as a
    // tester link — doing so renders the public runtime over the app screen.
    expect(extractScenarioTokenFromPath("/user-testing/host_123")).toBeNull();
    expect(extractScenarioTokenFromPath("/user-testing/new")).toBeNull();
  });

  it("detects an active scenario session", () => {
    expect(hasActiveScenarioSession()).toBe(false);

    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Demo Scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    expect(hasActiveScenarioSession()).toBe(true);
  });

  it("round-trips scenario session storage", () => {
    const payload = {
      projectId: "ws_1",
      scenarioId: "sbx_1",
      name: "Scenario",
      description: "Hosted scenario",
      hostStyle: "chatgpt" as const,
      mode: "anyone_with_link" as const,
      allowGuestAccess: true,
      viewerIsProjectMember: false,
      systemPrompt: "System prompt",
      modelId: "openai/gpt-5-mini",
      temperature: 0.7,
      requireToolApproval: false,
      servers: [
        {
          serverId: "srv_1",
          serverName: "Bench",
          useOAuth: true,
          serverUrl: "https://example.com/mcp",
          clientId: "client_1",
          oauthScopes: ["read"],
          oauthProtocolMode: "auto",
          oauthProtocolVersion: "2026-07-28",
          wireProtocolVersion: "2026-07-28",
        },
      ],
    };

    writeScenarioSession({ scenarioId: "sbx_1", accessVersion: 4, payload });

    expect(readScenarioSession()).toEqual({
      scenarioId: "sbx_1",
      accessVersion: 4,
      payload: {
        ...payload,
        servers: [
          {
            serverId: "srv_1",
            serverName: "Bench",
            useOAuth: true,
            serverUrl: "https://example.com/mcp",
            clientId: "client_1",
            oauthScopes: ["read"],
            oauthProtocolMode: "auto",
            oauthProtocolVersion: "2026-07-28",
            wireProtocolVersion: "2026-07-28",
            optional: false,
          },
        ],
        chatUi: undefined,
      },
      surface: "share_link",
    });
  });

  it("round-trips the share token — recovery's only way back to a grant", () => {
    // The post-redeem URL strip removes the token from the address bar, so
    // the persisted copy is what re-redeem reads. A session that dropped it
    // could never recover from a rebind or a rotated guest identity.
    const payload = {
      projectId: "ws_1",
      scenarioId: "sbx_1",
      name: "Demo Scenario",
      hostStyle: "claude" as const,
      mode: "anyone_with_link" as const,
      allowGuestAccess: true,
      viewerIsProjectMember: false,
      systemPrompt: "You are helpful.",
      modelId: "openai/gpt-5-mini",
      temperature: 0.4,
      requireToolApproval: false,
      servers: [],
    };

    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 2,
      payload,
      shareToken: "tok_share",
    });

    expect(readScenarioSession()?.shareToken).toBe("tok_share");
  });

  it("rejects stored sessions that lack a top-level scenarioId or accessVersion", () => {
    sessionStorage.setItem(
      SCENARIO_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: "scenario-token",
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_1",
          name: "Old Scenario",
          hostStyle: "claude",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      })
    );

    // Stored row predates the post-refactor session shape; reading it must
    // produce null so the landing page falls through to re-redeem rather than
    // silently driving the read path without a scenarioId/accessVersion.
    expect(readScenarioSession()).toBeNull();
  });

  it("defaults missing hostStyle to mcpjam for legacy scenario sessions", () => {
    sessionStorage.setItem(
      SCENARIO_SESSION_STORAGE_KEY,
      JSON.stringify({
        scenarioId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_1",
          name: "Legacy Scenario",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      })
    );

    expect(readScenarioSession()).toEqual({
      scenarioId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Legacy Scenario",
        description: undefined,
        hostStyle: "mcpjam",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
        chatUi: undefined,
      },
      surface: "share_link",
    });
  });

  it("preserves extensible hostStyle ids before a host definition is registered", () => {
    sessionStorage.setItem(
      SCENARIO_SESSION_STORAGE_KEY,
      JSON.stringify({
        scenarioId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          scenarioId: "sbx_1",
          name: "Codex Scenario",
          hostStyle: "codex",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      })
    );

    expect(readScenarioSession()?.payload.hostStyle).toBe("codex");
  });

  it("preserves preview surface when explicitly stored", () => {
    writeScenarioSession({
      scenarioId: "sbx_1",
      accessVersion: 1,
      surface: "preview",
      payload: {
        projectId: "ws_1",
        scenarioId: "sbx_1",
        name: "Playground Scenario",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    expect(readScenarioSession()?.surface).toBe("preview");
  });

  it("reads scenario surface from the url query", () => {
    expect(readScenarioSurfaceFromUrl("?surface=preview")).toBe("preview");
    expect(readScenarioSurfaceFromUrl("?surface=share_link")).toBe("share_link");
    expect(readScenarioSurfaceFromUrl("?surface=other")).toBe("share_link");
    expect(readScenarioSurfaceFromUrl("")).toBe("share_link");
  });

  it("round-trips scenario sign-in return path", () => {
    writeScenarioSignInReturnPath("/user-testing/demo/token-123");
    expect(readScenarioSignInReturnPath()).toBe("/user-testing/demo/token-123");

    // The writer validates through the tester-link matcher, so the retired
    // `/chatbox/…` shape is not merely unreachable — it cannot be stored as a
    // return path either, and a stale one left in localStorage is dropped.
    clearScenarioSignInReturnPath();
    writeScenarioSignInReturnPath("/chatbox/demo/token-123");
    expect(readScenarioSignInReturnPath()).toBeNull();

    clearScenarioSignInReturnPath();
    expect(readScenarioSignInReturnPath()).toBeNull();
  });

  it("ignores non-scenario sign-in return paths", () => {
    writeScenarioSignInReturnPath("/servers");
    expect(readScenarioSignInReturnPath()).toBeNull();

    localStorage.setItem(SCENARIO_SIGN_IN_RETURN_PATH_STORAGE_KEY, "/servers");
    expect(readScenarioSignInReturnPath()).toBeNull();
  });

  it("builds scenario links from the current browser origin", () => {
    expect(buildScenarioLink("token 123", "Demo Scenario")).toBe(
      `${window.location.origin}/user-testing/demo-scenario/token%20123`
    );
  });
});

/**
 * The chatUi envelope carries what the hosted runtime is allowed to render.
 * Its normalizer is an ALLOWLIST — a surface it does not recognize is dropped
 * silently, which is exactly how a config can ship and appear to do nothing.
 */
describe("chatUi surface normalization", () => {
  function session(chatUi: unknown) {
    return {
      scenarioId: "cbx_1",
      accessVersion: 1,
      payload: {
        projectId: "proj_1",
        scenarioId: "cbx_1",
        name: "Scenario",
        hostStyle: "claude",
        mode: "anyone_with_link",
        allowGuestAccess: true,
        viewerIsProjectMember: false,
        systemPrompt: "",
        modelId: "gpt-4o-mini",
        temperature: 0.5,
        requireToolApproval: false,
        servers: [],
        chatUi,
      },
    } as never;
  }

  it("keeps per-turn feedback config on a scenario with no welcome dialog", () => {
    // The normalizer used to return undefined unless `welcome` parsed, which
    // would have dropped the ratings config on most scenarios — they have no
    // welcome dialog.
    const normalized = normalizeScenarioSession(
      session({
        surfaces: {
          perTurnFeedback: { enabled: true, prompt: "How was that?" },
        },
      })
    );
    expect(normalized?.payload.chatUi?.surfaces?.perTurnFeedback).toEqual({
      enabled: true,
      prompt: "How was that?",
    });
  });

  it("keeps both surfaces when both are present", () => {
    const normalized = normalizeScenarioSession(
      session({
        surfaces: {
          welcome: { enabled: true, body: "hello" },
          perTurnFeedback: { enabled: false },
        },
      })
    );
    expect(normalized?.payload.chatUi?.surfaces?.welcome).toEqual({
      enabled: true,
      body: "hello",
    });
    expect(normalized?.payload.chatUi?.surfaces?.perTurnFeedback).toEqual({
      enabled: false,
    });
  });

  it("drops the deprecated session-level feedback dialog", () => {
    // Its write path and storage table are gone; carrying it into the runtime
    // would offer a dialog that saves nowhere.
    const normalized = normalizeScenarioSession(
      session({ surfaces: { feedback: { enabled: true } } })
    );
    expect(normalized?.payload.chatUi).toBeUndefined();
  });

  it("never null-punches an omitted optional string", () => {
    const normalized = normalizeScenarioSession(
      session({ surfaces: { perTurnFeedback: { enabled: true } } })
    );
    expect(
      normalized?.payload.chatUi?.surfaces?.perTurnFeedback
    ).not.toHaveProperty("prompt");
  });

  it("carries the thumbs style through", () => {
    const normalized = normalizeScenarioSession(
      session({
        surfaces: { perTurnFeedback: { enabled: true, style: "thumbs" } },
      })
    );
    expect(normalized?.payload.chatUi?.surfaces?.perTurnFeedback).toEqual({
      enabled: true,
      style: "thumbs",
    });
  });

  it("omits the style rather than copying an unrecognised one", () => {
    // A CLOSED enum, not a pass-through string: the value picks which widget
    // renders and which score key the tester writes under, so an unknown value
    // copied through would produce a scenario whose widget renders nothing.
    // Absence means stars downstream.
    for (const style of ["hearts", "", 5, null, "THUMBS"]) {
      const normalized = normalizeScenarioSession(
        session({
          surfaces: { perTurnFeedback: { enabled: true, style } },
        })
      );
      expect(
        normalized?.payload.chatUi?.surfaces?.perTurnFeedback
      ).not.toHaveProperty("style");
    }
  });

  it("keeps stars implicit rather than writing it out", () => {
    const normalized = normalizeScenarioSession(
      session({
        surfaces: { perTurnFeedback: { enabled: true, style: "stars" } },
      })
    );
    // Absence IS stars — one representation, so no reader has to handle two.
    expect(
      normalized?.payload.chatUi?.surfaces?.perTurnFeedback
    ).not.toHaveProperty("style");
  });
});
