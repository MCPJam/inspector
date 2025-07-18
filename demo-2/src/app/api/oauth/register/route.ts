import { NextRequest, NextResponse } from 'next/server';
import { registerOAuthClient, getDefaultRegistrationOptions } from '@/lib/oauth-registration';
import { createErrorResponse } from '@/lib/mcp-utils';
import { AuthorizationServerMetadata } from '@/lib/oauth-types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { authorizationServerMetadata, options = {} } = body;

    if (!authorizationServerMetadata) {
      return NextResponse.json(
        { error: 'authorizationServerMetadata is required' },
        { status: 400 }
      );
    }

    // Validate authorization server metadata
    if (!authorizationServerMetadata.registration_endpoint) {
      return NextResponse.json(
        { error: 'Authorization server does not support dynamic client registration' },
        { status: 400 }
      );
    }

    // Prepare registration options
    const registrationOptions = {
      ...getDefaultRegistrationOptions(),
      ...options,
      timeout: options.timeout || 30000
    };

    // Register OAuth client
    const registrationResult = await registerOAuthClient(
      authorizationServerMetadata as AuthorizationServerMetadata,
      registrationOptions
    );

    if (!registrationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: registrationResult.error?.error || 'registration_failed',
          error_description: registrationResult.error?.error_description || 'Client registration failed'
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      client_registration: registrationResult.client_registration,
      registered_at: registrationResult.registered_at
    });

  } catch (error) {
    console.error('OAuth registration error:', error);
    return createErrorResponse(
      'OAuth client registration failed',
      error instanceof Error ? error.message : 'Unknown error'
    );
  }
}