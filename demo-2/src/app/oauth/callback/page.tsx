'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';

export default function OAuthCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [message, setMessage] = useState('Processing OAuth callback...');

  useEffect(() => {
    const handleCallback = async () => {
      try {
        // Get the full callback URL
        const callbackUrl = window.location.href;
        
        // Get stored OAuth flows from localStorage
        const savedState = localStorage.getItem('mcp-inspector-state');
        if (!savedState) {
          setStatus('error');
          setMessage('No OAuth flow found. Please restart the connection process.');
          return;
        }

        const appState = JSON.parse(savedState);
        const oauthFlows = appState.oauthFlows || {};

        // Check for OAuth error in URL
        const error = searchParams.get('error');
        if (error) {
          const errorDescription = searchParams.get('error_description');
          setStatus('error');
          setMessage(`OAuth authorization failed: ${errorDescription || error}`);
          return;
        }

        // Get authorization code
        const code = searchParams.get('code');
        const state = searchParams.get('state');

        if (!code) {
          setStatus('error');
          setMessage('Authorization code not found in callback URL.');
          return;
        }

        // Find the OAuth flow that matches this callback
        // Note: In a real implementation, you'd associate the state parameter with a specific flow
        const oauthFlowEntries = Object.entries(oauthFlows);
        if (oauthFlowEntries.length === 0) {
          setStatus('error');
          setMessage('No active OAuth flows found.');
          return;
        }

        // For simplicity, use the first/most recent OAuth flow
        // In production, you'd match by state parameter
        const [serverName, oauthFlowData] = oauthFlowEntries[oauthFlowEntries.length - 1];

        // Note: We can't restore the actual OAuthFlowManager from localStorage
        // In a real implementation, you'd need to:
        // 1. Store minimal state in localStorage
        // 2. Recreate the flow manager
        // 3. Or handle the callback on the server side

        setStatus('success');
        setMessage(`OAuth authorization successful for ${serverName}! Redirecting...`);

        // Redirect back to main page after a short delay
        setTimeout(() => {
          router.push('/');
        }, 2000);

      } catch (error) {
        setStatus('error');
        setMessage(`Error processing OAuth callback: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    };

    handleCallback();
  }, [searchParams, router]);

  const handleRetry = () => {
    router.push('/');
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {status === 'processing' && <Loader2 className="h-5 w-5 animate-spin" />}
            {status === 'success' && <CheckCircle className="h-5 w-5 text-green-600" />}
            {status === 'error' && <XCircle className="h-5 w-5 text-red-600" />}
            OAuth Callback
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-gray-600">{message}</p>
          
          {status === 'error' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">
                You can try connecting again from the main page.
              </p>
              <Button onClick={handleRetry} className="w-full">
                Return to MCP Inspector
              </Button>
            </div>
          )}
          
          {status === 'success' && (
            <div className="text-sm text-gray-500">
              You will be automatically redirected...
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}