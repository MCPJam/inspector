"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function OAuthCallback() {
  const router = useRouter();

  useEffect(() => {
    // Simply redirect back to the main page with the callback parameters
    // The main page will handle the OAuth completion
    const currentUrl = window.location.href;
    const mainPageUrl = new URL("/", window.location.origin);

    // Copy all search parameters to the main page URL
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.forEach((value, key) => {
      mainPageUrl.searchParams.set(key, value);
    });

    // Redirect to main page with callback parameters
    router.replace(mainPageUrl.toString());
  }, [router]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            Processing OAuth Callback
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">Redirecting back to MCP Inspector...</p>
        </CardContent>
      </Card>
    </div>
  );
}
