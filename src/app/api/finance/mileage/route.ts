import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createMileageLog, deleteMileageLog, updateMileageLog } from "@/lib/tax";
import { NextResponse } from "next/server";

// Admin-only mileage CRUD (guarded exactly like the existing finance CSV/expense routes —
// no new public path, no origin-guard bypass). Agents cannot reach this surface.
export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const action = String(formData.get("_action") ?? "create").trim();
    const milesRaw = String(formData.get("miles") ?? "").replace(/[^0-9.]/g, "");
    const miles = Number(milesRaw);

    if (action === "delete") {
      await deleteMileageLog(String(formData.get("id") ?? "").trim());
    } else if (action === "update") {
      await updateMileageLog(String(formData.get("id") ?? "").trim(), {
        projectId: String(formData.get("projectId") ?? "").trim() || null,
        tripDate: String(formData.get("tripDate") ?? "").trim(),
        miles: Number.isFinite(miles) ? miles : 0,
        purpose: String(formData.get("purpose") ?? "").trim() || null,
        fromLocation: String(formData.get("fromLocation") ?? "").trim() || null,
        toLocation: String(formData.get("toLocation") ?? "").trim() || null,
        notes: String(formData.get("notes") ?? "").trim() || null,
      });
    } else {
      await createMileageLog({
        projectId: String(formData.get("projectId") ?? "").trim() || null,
        tripDate: String(formData.get("tripDate") ?? "").trim(),
        miles: Number.isFinite(miles) ? miles : 0,
        purpose: String(formData.get("purpose") ?? "").trim() || null,
        fromLocation: String(formData.get("fromLocation") ?? "").trim() || null,
        toLocation: String(formData.get("toLocation") ?? "").trim() || null,
        notes: String(formData.get("notes") ?? "").trim() || null,
      });
    }

    const redirectUrl = new URL("/finance/tax", request.url);
    redirectUrl.searchParams.set("saved", "mileage");
    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Mileage log update failed." },
      { status: 400 },
    );
  }
}
