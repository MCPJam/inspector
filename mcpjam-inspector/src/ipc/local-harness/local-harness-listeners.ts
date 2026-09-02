import { dialog, ipcMain, safeStorage } from "electron";
import type { BrowserWindow } from "electron";
import log from "electron-log";

/**
 * The privileged half of "choose the folder Claude Code may work in".
 *
 * ── Why the picker runs here and not in the renderer ─────────────────────
 * The workspace grant is the boundary the whole local target is scoped to. If a
 * renderer could name the path, then anything that can drive the renderer —
 * including the agent, through a page it renders — could name `/` and the grant
 * would be honest about a directory nobody chose.
 *
 * So the path never exists in the renderer. This handler opens the OS dialog,
 * takes what the USER picked, and registers it with the local server itself.
 * What crosses back to the renderer is the opaque grant id and a
 * tilde-shortened display root, which is all the consent sheet renders.
 *
 * The sender-identity check is the same one `app:open-external` uses: an IPC
 * channel that opens a native dialog and mints a filesystem grant is exactly
 * the kind a stray webview must not be able to reach.
 */
export function registerLocalHarnessListeners(
  getMainWindow: () => BrowserWindow | null,
  getServerOrigin: () => string | null,
  getSessionToken: () => string | null,
): void {
  ipcMain.handle("local-harness:pick-workspace", async (event) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
      log.warn(
        `Ignoring local-harness:pick-workspace from untrusted sender ` +
          `(id: ${event.sender.id})`,
      );
      throw new Error("Refusing a workspace pick from an untrusted renderer");
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose the folder Claude Code may work in",
      // Directories only, exactly one. A file is not a workspace, and two
      // workspaces is not a thing the grant model has a shape for.
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Grant access",
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const chosen = result.filePaths[0]!;

    const origin = getServerOrigin();
    if (origin === null) {
      throw new Error("The Inspector server is not running yet");
    }
    // Registered through the server's own loopback route rather than by
    // importing the grants module here: the server is the process that owns
    // that state, and having two writers to it is how a lock stops meaning
    // anything.
    const sessionToken = getSessionToken();
    const response = await fetch(
      new URL("/api/mcp/local-harness/workspace-grant", origin).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Same-origin by construction — this IS the app talking to its own
          // server — and the route re-checks it inside the handler.
          origin,
          ...(sessionToken ? { "X-MCP-Session-Auth": sessionToken } : {}),
        },
        body: JSON.stringify({ path: chosen }),
      },
    );
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        detail?.error ?? "That folder could not be granted to the harness",
      );
    }
    // Opaque id and display root only. The absolute path stops here.
    return (await response.json()) as {
      workspaceGrantId: string;
      displayRoot: string;
    };
  });

  /**
   * Whether the OS keystore is usable for the instance key.
   *
   * The renderer asks only so the consent sheet can say where the key lives;
   * the server decides for itself, through the store injected below.
   */
  ipcMain.handle("local-harness:keystore-available", () =>
    safeStorage.isEncryptionAvailable(),
  );
}

/**
 * The keystore the server's `instance-key.ts` seals its private key with.
 *
 * Handed to the server as functions rather than imported by it, so the server
 * module stays loadable under `npx`, where there is no Electron at all.
 */
export function createSafeStorageKeyStore(): {
  isAvailable: () => boolean;
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
} {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) =>
      safeStorage.encryptString(plaintext).toString("base64"),
    decrypt: (ciphertext) =>
      safeStorage.decryptString(Buffer.from(ciphertext, "base64")),
  };
}
