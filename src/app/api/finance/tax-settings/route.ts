import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { updateFinanceTaxSettings } from "@/lib/tax";
import { NextResponse } from "next/server";

// Admin-only finance rate settings (set-aside %, mileage rate, 1099 threshold). Reports
// only — no money moved. Guarded like the other finance routes.
export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const num = (key: string) => {
      const raw = String(formData.get(key) ?? "").trim();
      if (!raw) return undefined;
      const value = Number(raw.replace(/[^0-9.]/g, ""));
      return Number.isFinite(value) ? value : undefined;
    };
    await updateFinanceTaxSettings({
      taxSetAsideRatePercent: num("taxSetAsideRatePercent"),
      mileageRateCents: num("mileageRateCents"),
      form1099ThresholdCents: num("form1099ThresholdCents"),
    });
    const redirectUrl = new URL("/finance/tax", request.url);
    redirectUrl.searchParams.set("saved", "settings");
    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Finance settings update failed." },
      { status: 400 },
    );
  }
}
