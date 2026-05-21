"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

type LineItem = {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unitPrice: string;
  isOptional: boolean;
};

const inputClass = "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none";

function newLineItem(): LineItem {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    quantity: 1,
    unitPrice: "",
    isOptional: false,
  };
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function ProposalPackageBuilder({
  initialItems = [],
}: {
  initialItems?: Array<{
    id: string;
    name: string;
    description: string | null;
    quantity: number;
    unitPriceCents: number;
    isOptional?: boolean | null;
  }>;
}) {
  const [items, setItems] = useState<LineItem[]>(
    initialItems.length
      ? initialItems.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description ?? "",
          quantity: item.quantity,
          unitPrice: item.unitPriceCents ? String(item.unitPriceCents / 100) : "",
          isOptional: Boolean(item.isOptional),
        }))
      : [
          {
            id: crypto.randomUUID(),
            name: "Wedding photography coverage",
            description: "Primary wedding day coverage and edited image gallery.",
            quantity: 1,
            unitPrice: "",
            isOptional: false,
          },
        ],
  );

  const total = useMemo(() => items.reduce((sum, item) => {
    if (item.isOptional) return sum;
    const quantity = Number(item.quantity) || 0;
    const price = Number(String(item.unitPrice).replace(/[^0-9.]/g, "")) || 0;
    return sum + quantity * price;
  }, 0), [items]);

  function updateItem(id: string, patch: Partial<LineItem>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function removeItem(id: string) {
    setItems((current) => current.length > 1 ? current.filter((item) => item.id !== id) : current);
  }

  return (
    <section className="md:col-span-2">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-lg font-semibold">Package line items</h2>
          <p className="mt-1 text-sm text-[var(--ink-muted)]">Build the custom package here. This total becomes the proposal and invoice amount.</p>
        </div>
        <div className="text-right">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">Package total</div>
          <div className="mt-1 text-2xl font-semibold">{formatMoney(total)}</div>
        </div>
      </div>

      <input type="hidden" name="lineItemComputedTotal" value={String(total)} />

      <div className="mt-4 space-y-3">
        {items.map((item, index) => (
          <div key={item.id} className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold">{item.isOptional ? "Optional add-on" : "Included package item"}</div>
              <label className="inline-flex items-center gap-2 text-sm font-medium text-[var(--ink-muted)]">
                <input
                  type="checkbox"
                  name={`lineItemOptional_${index}`}
                  checked={item.isOptional}
                  onChange={(event) => updateItem(item.id, { isOptional: event.target.checked })}
                  className="h-4 w-4 rounded border-[var(--line)]"
                />
                Client can choose this item
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_90px_150px_42px] md:items-end">
              <label className="space-y-1.5 text-sm font-medium">
                Item
                <input name="lineItemName" value={item.name} onChange={(event) => updateItem(item.id, { name: event.target.value })} placeholder="Engagement session" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Qty
                <input name="lineItemQuantity" value={item.quantity} onChange={(event) => updateItem(item.id, { quantity: Number(event.target.value) })} inputMode="numeric" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Price
                <input name="lineItemUnitPrice" value={item.unitPrice} onChange={(event) => updateItem(item.id, { unitPrice: event.target.value })} inputMode="decimal" placeholder="1200" className={inputClass} />
              </label>
              <button type="button" aria-label={`Remove line item ${index + 1}`} onClick={() => removeItem(item.id)} className="inline-flex h-10 items-center justify-center rounded-sm border border-[var(--line)] transition hover:border-[var(--danger)] hover:text-[var(--danger)]">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <label className="mt-3 block space-y-1.5 text-sm font-medium">
              Description
              <input name="lineItemDescription" value={item.description} onChange={(event) => updateItem(item.id, { description: event.target.value })} placeholder="What is included in this line item." className={inputClass} />
            </label>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setItems((current) => [...current, newLineItem()])}
        className="mt-3 inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]"
      >
        <Plus className="h-4 w-4" />
        Add line item
      </button>
    </section>
  );
}
