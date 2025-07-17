import { NextRequest, NextResponse } from 'next/server';
import { clients } from '../connect/route';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const serverName = searchParams.get('server');
    const promptName = searchParams.get('name');

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

    if (promptName) {
      // Get specific prompt
      const args = Object.fromEntries(searchParams.entries());
      delete args.server;
      delete args.name;
      
      const content = await client.prompts.get(promptName, args);
      return NextResponse.json({ content });
    } else {
      // List all prompts
      const prompts = await client.prompts.list();
      return NextResponse.json({ prompts });
    }
  } catch (error) {
    console.error('Error with prompts:', error);
    return NextResponse.json(
      { error: 'Failed to access prompts', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}