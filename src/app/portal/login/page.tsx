import { LockKeyhole, MailCheck } from "lucide-react";

export const dynamic = "force-dynamic";

// Phase 6.5 — public self-service portal sign-in. Server component; no client JS
// beyond a native form POST. The confirmation copy is ALWAYS the same regardless
// of whether the address matched (no email enumeration — see request-link route
// and portal.ts requestPortalMagicLink).
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;
  const enabled = process.env.PORTAL_MAGIC_LINK_ENABLED === "1";

  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-10 text-[var(--foreground)]">
      <div className="mx-auto max-w-xl rounded-md border border-[var(--line)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#edf6f1] text-[var(--accent)]">
          <LockKeyhole className="h-5 w-5" />
        </div>
        <h1 className="brand-page-title mt-5 text-3xl">Client portal</h1>

        {!enabled ? (
          <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
            Open a secure portal link from Tyler to view your project. Portal links are project-specific and can be revoked at any time.
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
              Enter the email on your project and we&apos;ll send you a secure sign-in link. The link expires shortly and can be used once.
            </p>

            {sent === "1" && (
              <p className="mt-4 flex items-start gap-2 rounded-md border border-[var(--line)] bg-[#edf6f1] p-3 text-sm text-[var(--foreground)]">
                <MailCheck className="mt-0.5 h-4 w-4 text-[var(--accent)]" />
                <span>If that email is on file, we&apos;ve sent a sign-in link. Check your inbox.</span>
              </p>
            )}

            {error === "expired" && (
              <p className="mt-4 rounded-md border border-[var(--danger)] bg-[#fff4f1] p-3 text-sm text-[var(--danger)]">
                That link has expired or was already used — request a new one below.
              </p>
            )}
            {error === "rate" && (
              <p className="mt-4 rounded-md border border-[var(--danger)] bg-[#fff4f1] p-3 text-sm text-[var(--danger)]">
                Too many requests right now. Please wait a few minutes and try again.
              </p>
            )}
            {error === "config" && (
              <p className="mt-4 rounded-md border border-[var(--danger)] bg-[#fff4f1] p-3 text-sm text-[var(--danger)]">
                Sign-in is temporarily unavailable. Please reach out to Tyler.
              </p>
            )}

            <form method="POST" action="/api/portal/request-link" className="mt-6 space-y-3">
              <label htmlFor="portal-login-email" className="block text-sm font-medium">
                Email
              </label>
              <input
                id="portal-login-email"
                type="email"
                name="email"
                required
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                className="w-full rounded-md border border-[var(--line)] bg-[var(--background)] px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="w-full rounded-md border border-[var(--foreground)] bg-[var(--foreground)] px-4 py-2 text-sm font-semibold text-[var(--surface)]"
              >
                Email me a sign-in link
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
