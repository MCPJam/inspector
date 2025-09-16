let activeTunnel: any | null = null;
let httpsUrl: string | null = null;
let starting: Promise<string> | null = null;

// Maintain the existing name/signature for compatibility, but ignore auth tokens.
export async function ensureNgrokTunnel(
  port: number,
  _authToken?: string,
): Promise<string> {
  if (httpsUrl) return httpsUrl;
  if (starting) return starting;

  starting = (async () => {
    // Use a tokenless HTTPS tunnel via localtunnel
    const mod = await import("localtunnel");
    const localtunnel = (mod as any).default ?? mod;
    activeTunnel = await localtunnel({ port });
    httpsUrl = activeTunnel?.url || null;
    if (!httpsUrl) throw new Error("Failed to establish HTTPS tunnel");
    // Ensure HTTPS scheme
    if (httpsUrl.startsWith("http://")) {
      httpsUrl = httpsUrl.replace(/^http:\/\//, "https://");
    }
    return httpsUrl;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export function getNgrokUrl(): string | null {
  return httpsUrl;
}

export async function closeTunnel(): Promise<void> {
  try {
    if (activeTunnel && typeof activeTunnel.close === "function") {
      await activeTunnel.close();
    }
  } finally {
    activeTunnel = null;
    httpsUrl = null;
  }
}
