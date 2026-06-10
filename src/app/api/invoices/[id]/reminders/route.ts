import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { logInvoiceReminderFromForm } from "@/lib/sales";
import { NextResponse } from "next/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const { id } = await params;
    const formData = await request.formData();
    formData.set("invoiceId", id);
    const { invoiceId } = await logInvoiceReminderFromForm(formData);

    return NextResponse.redirect(new URL(`/invoices/${invoiceId}`, request.url), 303);
  } catch (error) {
    console.error("Invoice reminder log failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invoice reminder log failed." },
      { status: 400 },
    );
  }
}
