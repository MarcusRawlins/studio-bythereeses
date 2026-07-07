import { updateLeadFormConfigFromForm } from "@/lib/lead-form";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Admin-only lead-form config write. This is a GENUINE admin surface: it is NOT in
// isSchedulePublicPath / isStudioPublicPath, NOT in the origin-guard bypass, and NOT in the
// adminProofRequired exemptions — so on the studio host it is behind the admin Google session (and
// an admin proof under ADMIN_PROOF_ENFORCE). It calls the DEDICATED updateLeadFormConfigFromForm
// action (MINOR-9), which writes ONLY lead_form_config_json and never resets business settings.
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  await updateLeadFormConfigFromForm(formData);
  return NextResponse.redirect(new URL("/settings", request.url), 303);
}
