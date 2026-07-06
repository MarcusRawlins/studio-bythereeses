import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { updateIntelligenceSettings } from "@/lib/intelligence";
import { NextResponse } from "next/server";

// Admin-only intelligence/forecasting settings (horizon, trailing window, monthly
// capacity target, lead-source taxonomy). Reports only — no money moved, no business
// row written. Guarded exactly like the other finance settings routes. Agents cannot
// reach this surface (admin-guarded, not in the MCP tool list).
export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const num = (key: string) => {
      const raw = String(formData.get(key) ?? "").trim();
      if (!raw) return null; // empty clears the setting → NULL → code default
      const value = Number(raw.replace(/[^0-9.]/g, ""));
      return Number.isFinite(value) ? value : null;
    };
    await updateIntelligenceSettings({
      forecastHorizonMonths: num("forecastHorizonMonths"),
      forecastTrailingMonths: num("forecastTrailingMonths"),
      monthlyCapacityTarget: num("monthlyCapacityTarget"),
      leadSourceTaxonomyJson: String(formData.get("leadSourceTaxonomyJson") ?? ""),
    });
    const redirectUrl = new URL("/finance/intelligence", request.url);
    redirectUrl.searchParams.set("saved", "settings");
    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Intelligence settings update failed." },
      { status: 400 },
    );
  }
}
