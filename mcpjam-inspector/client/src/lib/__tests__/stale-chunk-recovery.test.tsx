import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Toaster } from "@mcpjam/design-system/sonner";
import { toast } from "sonner";
import {
  STALE_CHUNK_RELOAD_KEY,
  STALE_CHUNK_RELOAD_WINDOW_MS,
  claimAutomaticReload,
  installStaleChunkRecovery,
  isChunkLoadError,
  isEditing,
  isNewBuildServed,
  type StaleChunkRecoveryDeps,
} from "../stale-chunk-recovery";

const originalLocation = window.location;

// What Vite's preload helper dispatches when a content-hashed chunk from an
// older build is gone.
function failChunkLoad(): Event {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.assign(event, {
    payload: new TypeError(
      "Failed to fetch dynamically imported module: https://app.mcpjam.com/assets/highlighted-body-OFNGDK62-Bl5M65bX.js",
    ),
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function deps(
  overrides: Partial<StaleChunkRecoveryDeps> = {},
): StaleChunkRecoveryDeps {
  return {
    isNewBuildServed: async () => null,
    isEditing: () => false,
    claimAutomaticReload: () => true,
    reload: () => window.location.reload(),
    ...overrides,
  };
}

beforeAll(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: vi.fn() },
  });
});

afterAll(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

describe("stale chunk recovery", () => {
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    vi.mocked(window.location.reload).mockClear();
    render(<Toaster />);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    toast.dismiss();
    cleanup();
  });

  it("reloads once by itself when a newer build is confirmed", async () => {
    uninstall = installStaleChunkRecovery(
      deps({ isNewBuildServed: async () => true }),
    );

    failChunkLoad();

    await waitFor(() =>
      expect(window.location.reload).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("prompts instead of reloading while the user is editing", async () => {
    uninstall = installStaleChunkRecovery(
      deps({ isNewBuildServed: async () => true, isEditing: () => true }),
    );

    failChunkLoad();

    await screen.findByText("Reload MCPJam");
    await screen.findByText("A new version is available.");
    expect(window.location.reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("prompts instead of reloading again inside the loop guard", async () => {
    uninstall = installStaleChunkRecovery(
      deps({
        isNewBuildServed: async () => true,
        claimAutomaticReload: () => false,
      }),
    );

    failChunkLoad();

    await screen.findByText("Reload MCPJam");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("does not promise a new version when the build cannot be confirmed", async () => {
    uninstall = installStaleChunkRecovery(deps());

    failChunkLoad();

    await screen.findByText("Reload the page");
    expect(screen.queryByText("A new version is available.")).toBeNull();
    expect(window.location.reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("shows one prompt however many chunks fail", async () => {
    uninstall = installStaleChunkRecovery(deps());

    failChunkLoad();
    failChunkLoad();
    failChunkLoad();

    await screen.findByRole("button", { name: "Reload" });
    expect(screen.getAllByRole("button", { name: "Reload" })).toHaveLength(1);
  });

  it("leaves the import rejection to its caller", () => {
    uninstall = installStaleChunkRecovery(deps());
    // Cancelling the event would make the import resolve to undefined, and
    // the lazy component would fail later with a less useful error.
    expect(failChunkLoad().defaultPrevented).toBe(false);
  });
});

describe("isNewBuildServed", () => {
  const html = (entry: string) =>
    `<!doctype html><html><head><script type="module" src="${entry}"></script></head><body></body></html>`;
  const currentDoc = new DOMParser().parseFromString(
    html("/assets/index-old.js"),
    "text/html",
  );
  const fetchReturning = (body: string, ok = true) =>
    (async () => ({ ok, text: async () => body }) as Response) as typeof fetch;

  it("is true when the server's entry script differs from this tab's", async () => {
    await expect(
      isNewBuildServed(
        fetchReturning(html("/assets/index-new.js")),
        currentDoc,
      ),
    ).resolves.toBe(true);
  });

  it("is false when the server still serves this tab's build", async () => {
    await expect(
      isNewBuildServed(
        fetchReturning(html("/assets/index-old.js")),
        currentDoc,
      ),
    ).resolves.toBe(false);
  });

  it("is unknown when the document cannot be fetched", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(isNewBuildServed(failing, currentDoc)).resolves.toBeNull();
    await expect(
      isNewBuildServed(fetchReturning("", false), currentDoc),
    ).resolves.toBeNull();
  });

  it("is unknown when neither document names an entry script", async () => {
    await expect(
      isNewBuildServed(fetchReturning("<html></html>"), currentDoc),
    ).resolves.toBeNull();
  });
});

describe("claimAutomaticReload", () => {
  const store = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it("allows the first reload and blocks another inside the window", () => {
    const s = store();
    expect(claimAutomaticReload(s, 1_000)).toBe(true);
    expect(s.getItem(STALE_CHUNK_RELOAD_KEY)).toBe("1000");
    expect(claimAutomaticReload(s, 1_000 + STALE_CHUNK_RELOAD_WINDOW_MS)).toBe(
      false,
    );
    expect(claimAutomaticReload(s, 1_001 + STALE_CHUNK_RELOAD_WINDOW_MS)).toBe(
      true,
    );
  });

  it("still reloads once when storage is unavailable", () => {
    expect(claimAutomaticReload(null, 1_000)).toBe(true);
  });
});

describe("isEditing", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is false when nothing is focused", () => {
    expect(isEditing(document)).toBe(false);
  });

  it("is true inside a text field or contenteditable", () => {
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    expect(isEditing(document)).toBe(true);

    const editable = document.createElement("div");
    editable.tabIndex = 0;
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.append(editable);
    editable.focus();
    expect(isEditing(document)).toBe(true);
  });

  it("is false on a button", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    expect(isEditing(document)).toBe(false);
  });
});

describe("isChunkLoadError", () => {
  it("recognises the dynamic-import failures browsers raise", () => {
    expect(
      isChunkLoadError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://app.mcpjam.com/assets/trace-timeline-CtNEAoFZ.js",
        ),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Importing a module script failed.")),
    ).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError("error loading dynamically imported module: x"),
      ),
    ).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
