let activeTunnel: any | null = null;
let httpsUrl: string | null = null;
let starting: Promise<string> | null = null;

export async function ensureNgrokTunnel(
  port: number,
  authToken?: string,
): Promise<string> {
  if (httpsUrl) return httpsUrl;
  if (starting) return starting;

  starting = (async () => {
    const tokenToUse = authToken || process.env.NGROK_AUTHTOKEN;
    if (!tokenToUse) {
      throw new Error(
        "NGROK_AUTHTOKEN is required. Get one from https://dashboard.ngrok.com/get-started/your-authtoken"
      );
    }
    
    const ngrok = await import("@ngrok/ngrok");

    activeTunnel = await ngrok.default.forward({
      addr: String(port),
      authtoken: tokenToUse,
    });

    httpsUrl = activeTunnel.url();
    if (!httpsUrl) throw new Error("Failed to establish ngrok tunnel");

    console.log(`[ngrok] Tunnel established: ${httpsUrl}`);
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
    console.log("[ngrok] Tunnel closed");
  } finally {
    activeTunnel = null;
    httpsUrl = null;
  }
}
