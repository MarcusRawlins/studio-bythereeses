import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createInvoiceFromAgent, updateInvoiceFromAgent, type AgentInvoiceInput, type AgentInvoiceUpdateInput } from "@/lib/sales";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id } = await params;
    const body = await request.json() as AgentInvoiceInput;
    const invoice = await createInvoiceFromAgent(id, body);
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invoice creation failed." },
      { status: 400 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id } = await params;
    const invoiceId = new URL(request.url).searchParams.get("id")?.trim();
    if (!invoiceId) throw new Error("Invoice id is required.");
    const body = await request.json() as AgentInvoiceUpdateInput;
    const invoice = await updateInvoiceFromAgent(id, invoiceId, body);
    return NextResponse.json({ invoice });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invoice update failed." },
      { status: 400 },
    );
  }
}
