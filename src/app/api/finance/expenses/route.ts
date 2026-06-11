import { createExpenseFromForm, updateExpenseFromForm } from "@/lib/bookkeeping";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const formData = await request.formData();
    const action = String(formData.get("_action") ?? "create").trim();
    const expense = action === "update"
      ? await updateExpenseFromForm(formData)
      : await createExpenseFromForm(formData);
    const redirectUrl = new URL("/finance", request.url);
    redirectUrl.searchParams.set("saved", "expense");
    if (action === "update") redirectUrl.searchParams.set("expenseId", expense.id);
    const redirectKeys = [
      ["status", "ledgerStatus"],
      ["expenseStatus", "expenseStatus"],
      ["fromDate", "fromDate"],
      ["toDate", "toDate"],
      ["asOfDate", "asOfDate"],
    ] as const;
    for (const [queryKey, formKey] of redirectKeys) {
      const value = String(formData.get(formKey) ?? (formKey === "ledgerStatus" ? formData.get("status") : "") ?? "").trim();
      if (value) redirectUrl.searchParams.set(queryKey, value);
    }
    return NextResponse.redirect(redirectUrl, 303);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Expense creation failed." },
      { status: 400 },
    );
  }
}
