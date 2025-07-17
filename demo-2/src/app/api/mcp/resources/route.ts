import { NextRequest, NextResponse } from 'next/server';
import { clients } from '../connect/route';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const serverName = searchParams.get('server');
    const uri = searchParams.get('uri');

    if (!serverName) {
      return NextResponse.json(
        { error: 'Server name is required' },
        { status: 400 }
      );
    }

    const client = clients.get(serverName);
    if (!client) {
      return NextResponse.json(
        { error: 'Server not connected' },
        { status: 404 }
      );
    }

    if (uri) {
      // Read specific resource
      const content = await client.resources.read(uri);
      return NextResponse.json({ content });
    } else {
      // List all resources
      const resources = await client.resources.list();
      return NextResponse.json({ resources });
    }
  } catch (error) {
    console.error('Error with resources:', error);
    return NextResponse.json(
      { error: 'Failed to access resources', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { serverName } = await request.json();

    if (!serverName) {
      return NextResponse.json(
        { error: 'Server name is required' },
        { status: 400 }
      );
    }

    const client = clients.get(serverName);
    if (!client) {
      return NextResponse.json(
        { error: 'Server not connected' },
        { status: 404 }
      );
    }

    const templates = await client.resources.templates();
    return NextResponse.json({ templates });
  } catch (error) {
    console.error('Error fetching resource templates:', error);
    return NextResponse.json(
      { error: 'Failed to fetch resource templates', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}