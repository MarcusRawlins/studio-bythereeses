import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { updateVendorTaxInfo } from "@/lib/tax";
import { NextResponse } from "next/server";

// Admin-only W-9 / 1099 vendor tax entry (guarded). Stores ONLY the last 4 of the TIN.
// Agents cannot reach this surface (finance-adjacent) — see agent-finance-guard.test.ts.
export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    await updateVendorTaxInfo(String(formData.get("vendorId") ?? "").trim(), {
      legalName: String(formData.get("legalName") ?? "").trim() || null,
      taxIdLast4: String(formData.get("taxIdLast4") ?? "").trim() || null,
      taxAddress: String(formData.get("taxAddress") ?? "").trim() || null,
      is1099Tracked: formData.get("is1099Tracked") === "on",
    });
    const redirectUrl = new URL("/finance/tax", request.url);
    redirectUrl.searchParams.set("saved", "vendor");
    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Vendor tax update failed." },
      { status: 400 },
    );
  }
}
