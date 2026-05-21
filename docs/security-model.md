# Security Model

## Current MVP

- Portal links use 256-bit random tokens.
- Token hashes are stored with SHA-256; plaintext tokens are never stored.
- Portal sessions use httpOnly cookies with a 30-day max age.
- Revoked or expired tokens immediately clear portal cookies.
- Portal data is always loaded through token/project validation.
- Activity logs capture project creation, token generation, portal login, portal views, token revocation, and logout.

## Required Before Public Hosting

- Add admin Google OAuth restricted to Tyler's Google account.
- Set production cookie security to `secure: true`.
- Add rate limits to portal auth and token generation.
- Replace placeholder secrets with Cloudflare secrets.
- Add R2 private object access for files and generated PDFs.
- Run a route-level authorization review before deploying.
