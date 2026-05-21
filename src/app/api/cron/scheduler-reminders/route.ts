import { sendDueSchedulerReminders } from "@/lib/scheduler";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET || process.env.SCHEDULER_LINK_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (configuredSecret && provided !== configuredSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sendDueSchedulerReminders();
  return NextResponse.json(result);
}
