import { updateInvoicePaymentFromForm } from "@/lib/sales";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const { id } = await params;
    const formData = await request.formData();
    formData.set("invoiceId", id);
    const { invoiceId } = await updateInvoicePaymentFromForm(formData);

    return NextResponse.redirect(new URL(`/invoices/${invoiceId}`, request.url), 303);
  } catch (error) {
    console.error("Invoice payment update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invoice payment update failed." },
      { status: 400 },
    );
  }
}
