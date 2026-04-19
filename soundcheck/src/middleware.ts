import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

// Protect every route by default. `/callback` is whitelisted because that is
// where WorkOS returns users after sign-in. Static asset paths are excluded
// via the matcher below.
export default authkitMiddleware({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/callback"]
  }
});

export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"]
};
