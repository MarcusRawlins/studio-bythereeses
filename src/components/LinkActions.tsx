"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

type LinkActionsProps = {
  url: string;
  copyLabel?: string;
  copiedLabel?: string;
  openLabel?: string;
  className?: string;
  open?: boolean;
};

export function LinkActions({
  url,
  copyLabel = "Copy link",
  copiedLabel = "Copied",
  openLabel = "Open",
  className = "",
  open = true,
}: LinkActionsProps) {
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={copyUrl}
        className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]"
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? copiedLabel : copyLabel}
      </button>
      {open && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]"
        >
          <ExternalLink className="h-4 w-4" />
          {openLabel}
        </a>
      )}
    </div>
  );
}
