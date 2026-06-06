// WorkOS AuthKit callback route. Completes the sign-in redirect and
// returns the user to `/` afterward.
import { handleAuth } from "@workos-inc/authkit-nextjs";

function getCallbackBaseUrl(): string {
  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("NEXT_PUBLIC_WORKOS_REDIRECT_URI must be set");
  }

  return new URL(redirectUri).origin;
}

export const GET = handleAuth({
  // Railway can expose the internal bind address to Next during callbacks.
  // Force AuthKit's final post-login redirect back to the public app origin.
  baseURL: getCallbackBaseUrl()
});
