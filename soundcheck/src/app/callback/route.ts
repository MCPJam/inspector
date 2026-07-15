// WorkOS AuthKit callback route. Completes the sign-in redirect and
// returns the user to `/` afterward.
import { handleAuth } from "@workos-inc/authkit-nextjs";

// On Railway the app binds 0.0.0.0:$PORT, so `handleAuth`'s default
// `request.nextUrl` resolves to http://0.0.0.0:8080 and the post-login
// redirect lands there. Pin the public origin (derived from the configured
// redirect URI) so the user is returned to soundcheck.mcpjam.com.
const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
const baseURL = redirectUri ? new URL(redirectUri).origin : undefined;

export const GET = handleAuth(baseURL ? { baseURL } : {});
