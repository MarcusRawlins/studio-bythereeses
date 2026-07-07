import { AppShell } from "@/components/AppShell";
import { SettingsTabs } from "@/components/SettingsTabs";
import { isLeadFormEnabled } from "@/lib/inbound-inquiry";
import {
  getLeadFormConfig,
  LEAD_FORM_FIELD_LABELS,
  OPTIONAL_LEAD_FORM_FIELDS,
} from "@/lib/lead-form";
import { createLeadFormEmbedToken } from "@/lib/lead-form-links";
import { publicScheduleBaseUrl } from "@/lib/public-urls";
import { enabledPaymentMethods, getAppSettings, type PaymentMethodKey } from "@/lib/settings";
import { Code2, CreditCard, Landmark, Mail, Settings, ShieldCheck, WalletCards } from "lucide-react";
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
  // CR-2 (left-nav reorganization). Strict `=== "1"`, dark by default. Flag off ⇒ no tab strip,
  // page renders exactly as today.
  const settingsNavGroupEnabled = process.env.SETTINGS_NAV_GROUP === "1";

  // Phase 19: the lead-form editor is shown only when LEAD_FORM_ENABLED is on (dark by default, so
  // an off deploy renders Settings exactly as today). The embed snippet carries a freshly-signed
  // token minted at the CURRENT config.rev (MEDIUM-7).
  const leadFormEnabled = isLeadFormEnabled();
  const leadFormConfig = leadFormEnabled ? await getLeadFormConfig() : null;
  let leadFormSnippet = "";
  if (leadFormConfig) {
    const embedUrl = new URL("/embed/lead", publicScheduleBaseUrl());
    embedUrl.searchParams.set("t", createLeadFormEmbedToken(leadFormConfig.rev));
    leadFormSnippet = `<iframe src="${embedUrl.toString()}" title="Inquiry form" style="width:100%;border:0;min-height:720px" loading="lazy"></iframe>`;
  }

  return (
    <AppShell>
      <div className="space-y-6">
        {settingsNavGroupEnabled ? <SettingsTabs active="settings" /> : null}
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

        {leadFormConfig && (
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Embeddable lead form</h2>
            </div>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              Customize the inquiry form embedded on your marketing site. Name, email, and message are always shown and required.
            </p>

            {/* DEDICATED action (MINOR-9) — posts ONLY the lead-form config; never resets business settings. */}
            <form action="/api/lead-form/settings" method="post" className="mt-5 grid gap-4">
              <label className="space-y-1.5 text-sm font-medium">
                Intro text
                <textarea name="introText" rows={2} maxLength={500} defaultValue={leadFormConfig.introText} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
              </label>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1.5 text-sm font-medium">
                  Submit button text
                  <input name="submitButtonText" maxLength={60} defaultValue={leadFormConfig.submitButtonText} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Confirmation message
                  <input name="confirmationMessage" maxLength={500} defaultValue={leadFormConfig.confirmationMessage} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
              </div>

              <div className="grid gap-2">
                <div className="text-sm font-semibold">Optional fields</div>
                {OPTIONAL_LEAD_FORM_FIELDS.map((field) => {
                  const fieldConfig = leadFormConfig.fields[field];
                  return (
                    <div key={field} className="flex flex-wrap items-center gap-4 rounded-md border border-[var(--line)] px-3 py-2 text-sm">
                      <span className="min-w-[180px] font-medium">{LEAD_FORM_FIELD_LABELS[field]}</span>
                      <label className="inline-flex items-center gap-2">
                        <input type="checkbox" name={`${field}Enabled`} defaultChecked={fieldConfig.enabled} className="h-4 w-4 accent-[var(--brand-brown)]" />
                        Show
                      </label>
                      <label className="inline-flex items-center gap-2">
                        <input type="checkbox" name={`${field}Required`} defaultChecked={fieldConfig.required} className="h-4 w-4 accent-[var(--brand-brown)]" />
                        Required
                      </label>
                    </div>
                  );
                })}
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-[var(--ink-muted)]">
                <input type="checkbox" name="bumpRev" className="h-4 w-4 accent-[var(--brand-brown)]" />
                Revoke existing embed links (bump revision — you must re-copy and re-paste the snippet)
              </label>

              <button className="brand-primary-button w-full rounded-sm px-4 py-2.5 transition">
                Save lead form
              </button>
            </form>

            <div className="mt-6 space-y-1.5">
              <div className="text-sm font-semibold">Copy embed snippet</div>
              <p className="text-xs text-[var(--ink-muted)]">
                Paste this iframe on your marketing site. It carries a signed token for the current revision (rev {leadFormConfig.rev}).
              </p>
              <textarea readOnly rows={3} value={leadFormSnippet} className="w-full rounded-md border border-[var(--line)] bg-[#faf7f1] px-3 py-2 font-mono text-xs outline-none" />
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
