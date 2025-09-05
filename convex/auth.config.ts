<<<<<<< Updated upstream
import { convexAuth, customJwt } from "convex/server";

// WorkOS AuthKit issues JWTs whose JWK set is available at:
// https://api.workos.com/user_management/jwks
// We validate tokens against that JWKS and require the audience (aud)
// to match the WorkOS Client ID configured in the Convex environment.
export default convexAuth({
  providers: [
    customJwt({
      issuer: "https://api.workos.com/",
      jwksUri: "https://api.workos.com/user_management/jwks",
      audience: process.env.WORKOS_CLIENT_ID,
    }),
  ],
});
=======
const clientId = process.env.WORKOS_CLIENT_ID;

const authConfig = {
	providers: [
		{
			type: 'customJwt',
			issuer: `https://api.workos.com/`,
			algorithm: 'RS256',
			jwks: `https://api.workos.com/sso/jwks/${clientId}`,
			applicationID: clientId,
		},
		{
			type: 'customJwt',
			issuer: `https://api.workos.com/user_management/${clientId}`,
			algorithm: 'RS256',
			jwks: `https://api.workos.com/sso/jwks/${clientId}`,
			applicationID: clientId,
		},
	],
};

export default authConfig;

>>>>>>> Stashed changes

