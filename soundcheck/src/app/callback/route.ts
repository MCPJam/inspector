// WorkOS AuthKit callback route. Completes the sign-in redirect and
// returns the user to `/` afterward.
import { handleAuth } from "@workos-inc/authkit-nextjs";

export const GET = handleAuth();
