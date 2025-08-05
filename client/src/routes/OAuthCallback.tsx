import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function OAuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    // Extract OAuth callback parameters
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const errorParam = urlParams.get("error");
    
    if (errorParam) {
      setError(`OAuth authorization failed: ${errorParam}`);
      // Navigate home after a delay in case of error
      const timer = setTimeout(() => {
        navigate("/");
      }, 5000);
      
      return () => clearTimeout(timer);
    } else if (code) {
      // Redirect to home with code parameter
      navigate(`/?code=${encodeURIComponent(code)}`);
    } else {
      setError("Invalid OAuth callback: missing authorization code");
      // Navigate home after a delay in case of error
      const timer = setTimeout(() => {
        navigate("/");
      }, 5000);
      
      return () => clearTimeout(timer);
    }
  }, [navigate]);
  
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="text-center">
        {error ? (
          <div className="text-destructive">
            <p className="text-lg font-semibold">Authentication Error</p>
            <p className="mt-2">{error}</p>
            <p className="mt-4 text-muted-foreground">Redirecting to home page...</p>
          </div>
        ) : (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
            <p className="mt-4 text-foreground font-medium">Completing OAuth authorization...</p>
            <p className="mt-2 text-muted-foreground text-sm">You will be redirected automatically.</p>
          </>
        )}
      </div>
    </div>
  );
}