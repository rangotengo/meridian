# Meridian login with Cloudflare Access

The application supports both email codes and Google through the same verified
Cloudflare Access identity. The operator selects the providers in Cloudflare;
Meridian does not store the Google OAuth client secret.

## Confirmed hostnames

- Application: `https://meridian.arunshrestha.info.np`
- Team: `https://rangotengo.cloudflareaccess.com`
- Start with an empty cloud database. Do not copy or reset the local database.

## Enable Google and email codes

Google must be added to the organization before it appears in an application's
available identity providers.

1. In Google Cloud Console, create a project and configure the OAuth consent
   screen for a web application. Use only the basic identity scopes needed for
   sign-in. Add the intended users as test users if the consent screen is in
   Testing mode.
2. Create an OAuth client of type **Web application**, with these exact values:

   ```text
   Authorized JavaScript origin:
   https://rangotengo.cloudflareaccess.com

   Authorized redirect URI:
   https://rangotengo.cloudflareaccess.com/cdn-cgi/access/callback
   ```

3. In **Cloudflare Zero Trust → Integrations → Identity providers**, select
   **Add new identity provider → Google**. Enter the Google client ID and secret
   directly in Cloudflare, enable PKCE, save, and test the connection. Never put
   the client secret in this repository or chat.
4. Add **One-time PIN** under identity providers if it is not already listed.
5. Create a **Self-hosted** Access application named **Meridian** covering the
   entire `meridian.arunshrestha.info.np` hostname, including API paths.
6. Select **Google** and **One-time PIN** explicitly as login methods. Turn off
   automatic redirect to an identity provider so the login page offers both.
7. For open registration, add an **Allow** policy with two **Include → Login
   Methods** rules: **Google** and **One-time PIN**. Include rules are alternatives;
   either provider can admit a verified user. Remove the previous email allowlist
   policy if it is no longer needed. Never use a Bypass rule.
   For a private deployment instead, use an **Emails** rule listing exact addresses.
8. Copy the application's **Application Audience (AUD)** tag. This is public
   configuration, not a secret. Confirm Workers and Zero Trust use Free plans;
   the domain's Free Website plan alone does not establish that.

Official references:
[Google setup](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/),
[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/),
[JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Application configuration

Apply migration `0006_cloudflare_access` to a PostgreSQL deployment before
running this revision. Cloudflare database/runtime migration is separate and
not yet complete; these settings alone do not make the app deployable to Workers.

```dotenv
AUTH_MODE=cloudflare-access
APP_URL=https://meridian.arunshrestha.info.np
CF_ACCESS_TEAM_DOMAIN=rangotengo.cloudflareaccess.com
CF_ACCESS_AUD=<Meridian application AUD>
CF_ACCESS_PUBLIC_SIGNUP=true
```

This enables anyone admitted by the Access policy to create their own household.
For private registration, omit this flag and set `CF_ACCESS_ALLOWED_EMAILS` to the
same comma-separated email list as the Access policy. An empty allowlist without
explicit public signup fails closed. Requests without a valid signed assertion
cannot use a Meridian session cookie as a fallback.

The application verifies RS256 signatures against the team's public keys, issuer,
audience, expiry, issuance time, application token type, subject, and valid email.
Private registration additionally enforces the email allowlist.
It does not trust the plain `Cf-Access-Authenticated-User-Email` header. Unprotected
alternate hostnames must be disabled at deployment; signed identity checks remain
required even behind Access.

Cloudflare Access Free supports up to 50 users; open registration does not remove
that limit. Keep the Free plan to honor the $0 requirement. A larger public
service would need another authentication design or a changed budget.
See [Access pricing](https://www.cloudflare.com/plans/) and
[login-method policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).
For public Google signup, the Google OAuth consent screen must also allow the
intended audience rather than remaining limited to named test users.

## Account behavior

- A verified first-time user creates a household without a password. They become
  their household's administrator, never a platform super-admin automatically.
- An invited user can join directly using their verified Access identity.
- Existing accounts are matched by both Access subject and email. Password
  accounts are not silently linked. Removed members cannot sign back in unless
  they accept a fresh invitation for the same verified identity.
- Password signup, login, changes, resets, and password-based invitation signup
  are disabled when Access mode is enabled.
- Sign out uses `/cdn-cgi/access/logout`. Device session expiry and revocation
  are managed in Cloudflare Access, rather than the local session table.
- `AUTH_MODE=password` remains the default for existing local deployments.

## Release checks

Test email-code and Google login using the same email address; both must resolve
to the same Access subject and Meridian account. Test a new email in public mode
and rejection of an unlisted email in private mode. Also test an
expired token, another application's token, missing assertion, password endpoint
requests, invited-user onboarding, removal/rejoin, and logout in a real browser.
Local automated tests cover token validation and database behavior; live provider
configuration and deployed login still require verification.
