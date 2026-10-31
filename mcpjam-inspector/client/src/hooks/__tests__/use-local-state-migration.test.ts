import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationDeps } from "@/lib/local-state-migration";
import { useLocalStateMigration } from "../use-local-state-migration";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  ensureDefaultProject: vi.fn(),
  runLocalStateMigration: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "projects:createProject") return mocks.createProject;
    if (name === "projects:ensureDefaultProject")
      return mocks.ensureDefaultProject;
    return vi.fn();
  },
  useConvex: () => ({ query: vi.fn() }),
  useQuery: vi.fn(),
  useAction: vi.fn(),
}));

vi.mock("@/lib/local-state-migration", () => ({
  hasMigrationCompleted: () => false,
  runLocalStateMigration: mocks.runLocalStateMigration,
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  HOSTED_MODE: false,
}));

vi.mock("@/lib/apis/hosted-oauth-import-tokens-api", () => ({
  importHostedOAuthTokens: vi.fn(),
}));

vi.mock("../use-logger", () => ({
  useLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("useLocalStateMigration", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mocks.createProject.mockResolvedValue({ projectId: "p-1" });
    mocks.ensureDefaultProject.mockResolvedValue("p-default");
    mocks.runLocalStateMigration.mockResolvedValue({
      ok: true,
      projectsMigrated: 0,
      errors: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.documentElement.classList.remove("dark");
  });

  // The migration awaits one project before creating the next, so a theme
  // switched in between must reach the later creation.
  it("seeds each project with the theme rendered when it is created", async () => {
    renderHook(() =>
      useLocalStateMigration({
        isAuthenticated: true,
        isUserBootstrapping: false,
        organizationId: "org-1",
      }),
    );
    await waitFor(() =>
      expect(mocks.runLocalStateMigration).toHaveBeenCalledTimes(1),
    );
    const deps = mocks.runLocalStateMigration.mock.calls[0][0] as MigrationDeps;

    await deps.createProject({ name: "First", servers: {} });
    document.documentElement.classList.add("dark");
    await deps.ensureDefaultProject!({ organizationId: "org-1" });

    expect(mocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "First", themeMode: "light" }),
    );
    expect(mocks.ensureDefaultProject).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", themeMode: "dark" }),
    );
  });
});
