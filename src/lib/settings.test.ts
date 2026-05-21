import assert from "node:assert/strict";
import {
  defaultBusinessSettings,
  defaultPaymentSettings,
  enabledPaymentMethods,
  normalizeBusinessSettings,
  normalizePaymentSettings,
} from "./settings";

const business = normalizeBusinessSettings({
  businessName: "  Alex & Tyler Reese  ",
  publicBrandName: "",
  contactEmail: " HELLO@BYTHEREESES.COM ",
  websiteUrl: "bythereeses.com",
  instagramUrl: "@thereeses",
  timezone: "",
});

assert.equal(business.businessName, "Alex & Tyler Reese");
assert.equal(business.publicBrandName, defaultBusinessSettings.publicBrandName);
assert.equal(business.contactEmail, "hello@bythereeses.com");
assert.equal(business.websiteUrl, "https://bythereeses.com");
assert.equal(business.instagramUrl, "https://instagram.com/thereeses");
assert.equal(business.timezone, defaultBusinessSettings.timezone);

const payment = normalizePaymentSettings({
  stripe: { enabled: true, passFees: true, displayName: "", instructions: "ignored" },
  zelle: { enabled: true, displayName: " Zelle ", instructions: "  hello@bythereeses.com  " },
  venmo: { enabled: false, displayName: "Venmo", instructions: " @thereeses " },
  cashCheck: { enabled: true, displayName: "", instructions: "" },
});

assert.equal(payment.stripe.enabled, true);
assert.equal(payment.stripe.displayName, defaultPaymentSettings.stripe.displayName);
assert.equal(payment.stripe.instructions, "");
assert.equal(payment.zelle.instructions, "hello@bythereeses.com");
assert.equal(payment.venmo.enabled, false);
assert.equal(payment.venmo.instructions, "@thereeses");
assert.equal(payment.cashCheck.displayName, defaultPaymentSettings.cashCheck.displayName);

assert.deepEqual(
  enabledPaymentMethods(payment).map((method) => method.key),
  ["stripe", "zelle", "cashCheck"],
);

console.log("settings tests passed");
