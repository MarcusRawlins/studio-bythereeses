import { createInvoiceFromForm } from "@/lib/sales";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const { invoiceId } = await createInvoiceFromForm(formData);

    return NextResponse.redirect(new URL(`/invoices/${invoiceId}`, request.url), 303);
  } catch (error) {
    console.error("Invoice creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invoice creation failed." },
      { status: 400 },
    );
  }
}
