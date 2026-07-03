import { AppShell } from "@/components/AppShell";
import { enabledPaymentMethods, getAppSettings, type PaymentMethodKey } from "@/lib/settings";
import { CreditCard, Landmark, Mail, Settings, ShieldCheck, WalletCards } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

const paymentCopy: Record<PaymentMethodKey, { title: string; description: string; icon: typeof CreditCard }> = {
  stripe: {
    title: "Credit card",
    description: "Stripe checkout will use the connected account once payment collection is wired.",
    icon: CreditCard,
  },
  zelle: {
    title: "Zelle",
    description: "Manual payment details shown on invoices when this method is selected.",
    icon: Landmark,
  },
  venmo: {
    title: "Venmo",
    description: "Manual payment details shown on invoices when this method is selected.",
    icon: WalletCards,
  },
  cashCheck: {
    title: "Cash or check",
    description: "Offline payment option for clients who are not paying digitally.",
    icon: Mail,
  },
};

const paymentOrder: PaymentMethodKey[] = ["stripe", "zelle", "venmo", "cashCheck"];

export default async function SettingsPage() {
  const settings = await getAppSettings();
  const enabledMethods = enabledPaymentMethods(settings.paymentMethods);

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <h1 className="brand-page-title text-4xl">Settings</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ink-muted)]">
              Store business details and payment options once, then reuse them across invoices, proposal packages, and client-facing payment pages.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--ink-muted)]">
              <span className="font-semibold text-[var(--foreground)]">{enabledMethods.length}</span> payment methods enabled
            </div>
            <Link
              href="/system-status"
              prefetch={false}
              className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:border-[var(--ink)]"
            >
              <ShieldCheck className="h-4 w-4 text-[var(--brand-brown)]" />
              System status
            </Link>
          </div>
        </header>

        <form action="/api/settings" method="post" className="grid gap-6 xl:grid-cols-[420px_1fr]">
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Business profile</h2>
            </div>
            <div className="mt-5 grid gap-4">
              <label className="space-y-1.5 text-sm font-medium">
                Business name
                <input name="businessName" defaultValue={settings.businessName} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Public brand name
                <input name="publicBrandName" defaultValue={settings.publicBrandName} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Contact email
                <input name="contactEmail" type="email" defaultValue={settings.contactEmail} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Website
                <input name="websiteUrl" defaultValue={settings.websiteUrl} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Instagram
                <input name="instagramUrl" defaultValue={settings.instagramUrl} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Timezone
                <input name="timezone" defaultValue={settings.timezone} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
            </div>
          </section>

          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div>
              <h2 className="text-lg font-semibold">Payment options</h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                Turn methods on once here. Invoice creation will only ask which enabled methods apply.
              </p>
            </div>

            <div className="mt-5 grid gap-4">
              {paymentOrder.map((key) => {
                const method = settings.paymentMethods[key];
                const copy = paymentCopy[key];
                const Icon = copy.icon;
                return (
                  <section key={key} className="rounded-md border border-[var(--line)] p-4">
                    <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
                      <div className="flex gap-3">
                        <Icon className="mt-1 h-4 w-4 text-[var(--ink-muted)]" />
                        <div>
                          <h3 className="font-semibold">{copy.title}</h3>
                          <p className="mt-1 text-sm leading-5 text-[var(--ink-muted)]">{copy.description}</p>
                        </div>
                      </div>
                      <label className="inline-flex items-center gap-2 text-sm font-semibold">
                        <input type="checkbox" name={`${key}Enabled`} defaultChecked={method.enabled} className="h-4 w-4 accent-[var(--brand-brown)]" />
                        Enabled
                      </label>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <label className="space-y-1.5 text-sm font-medium">
                        Display name
                        <input name={`${key}DisplayName`} defaultValue={method.displayName} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                      </label>
                      {key !== "stripe" && (
                        <label className="space-y-1.5 text-sm font-medium">
                          Instructions
                          <input name={`${key}Instructions`} defaultValue={method.instructions} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                        </label>
                      )}
                    </div>

                    {(key === "stripe" || key === "zelle") && (
                      <label className="mt-3 inline-flex items-center gap-2 text-sm text-[var(--ink-muted)]">
                        <input type="checkbox" name={`${key}PassFees`} defaultChecked={method.passFees} className="h-4 w-4 accent-[var(--brand-brown)]" />
                        Pass processing fees to client when this method supports it
                      </label>
                    )}
                  </section>
                );
              })}
            </div>

            <button className="brand-primary-button mt-5 w-full rounded-sm px-4 py-2.5 transition">
              Save settings
            </button>
          </section>
        </form>
      </div>
    </AppShell>
  );
}
