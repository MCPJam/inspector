import { Hono } from 'hono';
import { tunnelManager } from '../../services/tunnel-manager';
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
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch ngrok token');
  }

  const data = await response.json();
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

// Create a tunnel for a server
tunnels.post('/:serverId/create', async (c) => {
  const serverId = c.req.param('serverId');
  const authHeader = c.req.header('authorization');

  try {
    // Check if tunnel already exists
    const existingUrl = tunnelManager.getTunnelUrl(serverId);
    if (existingUrl) {
      return c.json({
        url: existingUrl,
        serverId,
        existed: true,
      });
    }

    // Fetch ngrok token from Convex if not already set
    if (!tunnelManager.hasTunnel(serverId)) {
      const token = await fetchNgrokToken(authHeader);
      tunnelManager.setNgrokToken(token);
    }

    // Create the tunnel
    const url = await tunnelManager.createTunnel(serverId);

    // Record the tunnel in Convex backend
    await recordTunnel(serverId, url, authHeader);

    return c.json({
      url,
      serverId,
      existed: false,
    });
  } catch (error: any) {
    console.error('Error creating tunnel:', error);
    return c.json(
      {
        error: error.message || 'Failed to create tunnel',
        serverId,
      },
      500
    );
  }
});

// Get existing tunnel URL
tunnels.get('/:serverId', async (c) => {
  const serverId = c.req.param('serverId');
  const url = tunnelManager.getTunnelUrl(serverId);

  if (!url) {
    return c.json({ error: 'No tunnel found' }, 404);
  }

  return c.json({ url, serverId });
});

// Close a tunnel
tunnels.delete('/:serverId', async (c) => {
  const serverId = c.req.param('serverId');
  const authHeader = c.req.header('authorization');

  try {
    await tunnelManager.closeTunnel(serverId);
    await reportTunnelClosure(serverId, authHeader);

    return c.json({ success: true, serverId });
  } catch (error: any) {
    console.error('Error closing tunnel:', error);
    return c.json(
      {
        error: error.message || 'Failed to close tunnel',
        serverId,
      },
      500
    );
  }
});

// List all active tunnels
tunnels.get('/', async (c) => {
  const tunnels = tunnelManager.getActiveTunnels();
  return c.json({ tunnels });
});

export default tunnels;
