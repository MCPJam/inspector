import { Hono } from 'hono';
import { tunnelManager } from '../../services/tunnel-manager';
import { LOCAL_SERVER_ADDR } from '../../config';
import '../../types/hono';

const tunnels = new Hono();

// Fetch ngrok token from Convex backend
async function fetchNgrokToken(authHeader?: string): Promise<string> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new Error('CONVEX_HTTP_URL not configured');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  const response = await fetch(`${convexUrl}/tunnels/token`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error || 'Failed to fetch ngrok token');
  }

  const data = await response.json() as { ok?: boolean; token?: string };
  if (!data.ok || !data.token) {
    throw new Error('Invalid response from tunnel service');
  }

  return data.token;
}

// Report tunnel creation to Convex backend
async function recordTunnel(serverId: string, url: string, authHeader?: string): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    console.warn('CONVEX_HTTP_URL not configured, skipping tunnel recording');
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  try {
    await fetch(`${convexUrl}/tunnels/record`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ serverId, url }),
    });
  } catch (error) {
    console.error('Failed to record tunnel:', error);
    // Don't throw - tunnel is already created, just log the error
  }
}

// Report tunnel closure to Convex backend
async function reportTunnelClosure(serverId: string, authHeader?: string): Promise<void> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  try {
    await fetch(`${convexUrl}/tunnels/close`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ serverId }),
    });
  } catch (error) {
    console.error('Failed to report tunnel closure:', error);
  }
}

// Create a shared tunnel
tunnels.post('/create', async (c) => {
  const authHeader = c.req.header('authorization');

  try {
    // Check if tunnel already exists
    const existingUrl = tunnelManager.getTunnelUrl();
    if (existingUrl) {
      return c.json({
        url: existingUrl,
        existed: true,
      });
    }

    // Fetch ngrok token from Convex if not already set
    if (!tunnelManager.hasTunnel()) {
      const token = await fetchNgrokToken(authHeader);
      tunnelManager.setNgrokToken(token);
    }

    // Create the tunnel pointing to the local server
    const url = await tunnelManager.createTunnel(LOCAL_SERVER_ADDR);

    // Record the tunnel in Convex backend (use a fixed serverId for the shared tunnel)
    await recordTunnel('shared', url, authHeader);

    return c.json({
      url,
      existed: false,
    });
  } catch (error: any) {
    console.error('Error creating tunnel:', error);
    return c.json(
      {
        error: error.message || 'Failed to create tunnel',
      },
      500
    );
  }
});

// Get existing tunnel URL
tunnels.get('/', async (c) => {
  const url = tunnelManager.getTunnelUrl();

  if (!url) {
    return c.json({ error: 'No tunnel found' }, 404);
  }

  return c.json({ url });
});

// Get server-specific tunnel URL
tunnels.get('/server/:serverId', async (c) => {
  const serverId = c.req.param('serverId');
  const url = tunnelManager.getServerTunnelUrl(serverId);

  if (!url) {
    return c.json({ error: 'No tunnel found' }, 404);
  }

  return c.json({ url, serverId });
});

// Close the tunnel
tunnels.delete('/', async (c) => {
  const authHeader = c.req.header('authorization');

  try {
    await tunnelManager.closeTunnel();
    await reportTunnelClosure('shared', authHeader);

    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error closing tunnel:', error);
    return c.json(
      {
        error: error.message || 'Failed to close tunnel',
      },
      500
    );
  }
});

export default tunnels;
