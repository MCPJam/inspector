import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from '@/lib/mcp-utils';
import { TokenRequest, TokenResponse, OAuthError, GRANT_TYPES } from '@/lib/oauth-types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tokenEndpoint, tokenRequest, timeout = 30000 } = body;

    if (!tokenEndpoint || !tokenRequest) {
      return NextResponse.json(
        { error: 'tokenEndpoint and tokenRequest are required' },
        { status: 400 }
      );
    }

    // Validate token endpoint URL
    try {
      new URL(tokenEndpoint);
    } catch (error) {
      return NextResponse.json(
        { error: 'Invalid token endpoint URL' },
        { status: 400 }
      );
    }

    // Validate token request
    if (!tokenRequest.grant_type || !tokenRequest.client_id) {
      return NextResponse.json(
        { error: 'grant_type and client_id are required in token request' },
        { status: 400 }
      );
    }

    // Encode token request as form data
    const params = new URLSearchParams();
    Object.entries(tokenRequest as TokenRequest).forEach(([key, value]) => {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          value.forEach(v => params.append(key, v));
        } else {
          params.set(key, value.toString());
        }
      }
    });

    // Make token request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'MCP-Inspector/1.0'
      },
      body: params.toString(),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const tokens = await response.json() as TokenResponse;
      
      return NextResponse.json({
        success: true,
        tokens,
        expires_at: tokens.expires_in ? Date.now() + (tokens.expires_in * 1000) : undefined
      });
    } else {
      let error: OAuthError;
      try {
        error = await response.json() as OAuthError;
      } catch {
        error = {
          error: 'server_error',
          error_description: `Token request failed with status ${response.status}`
        };
      }

      return NextResponse.json(
        {
          success: false,
          error: error.error,
          error_description: error.error_description
        },
        { status: response.status }
      );
    }

  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return NextResponse.json(
        {
          success: false,
          error: 'timeout',
          error_description: 'Token request timed out'
        },
        { status: 408 }
      );
    }

    console.error('Token exchange error:', error);
    return createErrorResponse(
      'Token exchange failed',
      error instanceof Error ? error.message : 'Unknown error'
    );
  }
}