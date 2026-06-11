import { guardAgentApiRequest } from "@/lib/agent-api";
import { createExpenseFromAgent, updateExpenseFromAgent, type AgentExpenseInput, type AgentExpenseUpdateInput } from "@/lib/bookkeeping";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
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
    const body = await request.json() as AgentExpenseInput;
    const expense = await createExpenseFromAgent(id, body);
    return NextResponse.json({ expense }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Expense creation failed." },
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
    const expenseId = new URL(request.url).searchParams.get("id")?.trim();
    if (!expenseId) throw new Error("Expense id is required.");
    const body = await request.json() as AgentExpenseUpdateInput;
    const expense = await updateExpenseFromAgent(id, expenseId, body);
    return NextResponse.json({ expense });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Expense update failed." },
      { status: 400 },
    );
  }
}
