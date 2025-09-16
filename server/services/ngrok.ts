let ngrokListener: any | null = null;
let ngrokUrl: string | null = null;
let starting: Promise<string> | null = null;

export async function ensureNgrokTunnel(
  port: number,
  authToken?: string,
): Promise<string> {
  if (ngrokUrl) return ngrokUrl;
  if (starting) return starting;

  starting = (async () => {
    const tokenToUse = authToken || process.env.NGROK_AUTHTOKEN;
    if (!tokenToUse) {
      throw new Error(
        "NGROK_AUTHTOKEN not provided. Set env NGROK_AUTHTOKEN or pass authToken.",
      );
    }
    const mod = await import("@ngrok/ngrok");
    const ngrok = (mod as any).default ?? mod;
    ngrokListener = await ngrok.forward({
      addr: String(port),
      authtoken: tokenToUse,
    });
    ngrokUrl = ngrokListener.url();
    if (!ngrokUrl) throw new Error("Failed to establish ngrok tunnel");
    return ngrokUrl;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export function getNgrokUrl(): string | null {
  return ngrokUrl;
}


