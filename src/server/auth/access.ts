import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { errors } from "@/lib/errors";

const accessSchema = z
  .object({
    teamDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/),
    audience: z.string().min(1).max(256),
    allowedEmails: z.array(z.string().email()),
    allowPublicSignup: z.boolean().default(false)
  })
  .refine((config) => config.allowPublicSignup || config.allowedEmails.length > 0);

export type AccessConfig = z.infer<typeof accessSchema>;
export type AccessIdentity = { subject: string; email: string };

export function usesCloudflareAccess(): boolean {
  const mode = process.env.AUTH_MODE ?? "password";
  if (mode !== "password" && mode !== "cloudflare-access") {
    throw new Error("AUTH_MODE must be password or cloudflare-access.");
  }
  return mode === "cloudflare-access";
}

export function assertPasswordAuth(): void {
  if (usesCloudflareAccess()) {
    throw errors.forbidden("Sign-in and account credentials are managed by Cloudflare Access.");
  }
}

export function accessConfig(): AccessConfig {
  const publicSignup = process.env.CF_ACCESS_PUBLIC_SIGNUP ?? "false";
  const parsed = accessSchema.safeParse({
    allowPublicSignup:
      publicSignup === "true" ? true : publicSignup === "false" ? false : publicSignup,
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
    audience: process.env.CF_ACCESS_AUD,
    allowedEmails: (process.env.CF_ACCESS_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  });
  if (!parsed.success) {
    throw new Error(
      "Cloudflare Access requires a team domain, application AUD, and either allowed emails or explicit public signup."
    );
  }
  return parsed.data;
}

let remoteKeys: { domain: string; resolve: JWTVerifyGetKey } | undefined;

function accessKeys(domain: string): JWTVerifyGetKey {
  if (remoteKeys?.domain !== domain) {
    remoteKeys = {
      domain,
      resolve: createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`))
    };
  }
  return remoteKeys.resolve;
}

/** Verify the signed assertion, never the unauthenticated email header or a local session. */
export async function verifyAccessAssertion(
  assertion: string | null,
  config: AccessConfig,
  keys: JWTVerifyGetKey = accessKeys(config.teamDomain)
): Promise<AccessIdentity | null> {
  if (!assertion || assertion.length > 16384) return null;
  try {
    const { payload } = await jwtVerify(assertion, keys, {
      algorithms: ["RS256"],
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
      requiredClaims: ["iss", "aud", "exp", "iat", "sub", "email", "type"]
    });
    if (
      payload.type !== "app" ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 256 ||
      typeof payload.email !== "string"
    )
      return null;
    if (typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000)) return null;
    const email = payload.email.trim().toLowerCase();
    if (!z.string().email().safeParse(email).success) return null;
    if (!config.allowPublicSignup && !config.allowedEmails.includes(email)) return null;
    return { subject: payload.sub, email };
  } catch {
    // Invalid claims/signatures and unavailable keys all fail closed. Never log the token.
    return null;
  }
}
