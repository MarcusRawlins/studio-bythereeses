# Security Model

Last reviewed: 2026-07-03. See `docs/route-access-audit.md` for the current route-level access inventory.

## Current MVP

- Studio browser/admin routes are protected by the Pages front door Google sign-in flow restricted to Tyler's allowed email.
- Agent and MCP routes require `Authorization: Bearer <STUDIO_AGENT_API_TOKEN>`.
- Direct `*.workers.dev` access is blocked by `ORIGIN_PROXY_SECRET` except for intentionally public client-facing routes.
- The Pages proxy adds baseline browser security headers: HSTS, frame denial, nosniff, referrer policy, permissions policy, and a minimal CSP for frame/object/base hardening.
- The Pages proxy rate-limits admin OAuth, tokenized client-facing links, public scheduler/questionnaire mutations, and agent/MCP calls by client IP.
- Portal links use 256-bit random tokens.
- Token hashes are stored with SHA-256; plaintext tokens are never stored.
- Portal sessions use httpOnly cookies with a 30-day max age.
- Revoked or expired tokens immediately clear portal cookies.
- Portal data is always loaded through token/project validation.
- Activity logs capture project creation, token generation, portal login, portal views, token revocation, and logout.
- Dependency audit is clean as of this review. Next remains on stable `16.2.10`; its nested PostCSS dependency is patched with an npm override instead of accepting npm's breaking downgrade path.

## Remaining Hardening

- Replace the shared agent bearer token with scoped/rotatable agent credentials when multiple agents or external clients need access.
- Document token rotation and the "who has access" inventory for Cloudflare, Studio agent, and local Keychain secrets.
- Move front-door rate limiting to Cloudflare WAF/Turnstile or another durable edge control if public abuse becomes real; current in-proxy limits are a practical baseline, not a distributed abuse platform.
- Add re-auth or shorter-lived sessions for sensitive admin actions.
- Add R2 private object access for files and generated PDFs.
- Re-run the route-level authorization review before any major client-facing expansion.
