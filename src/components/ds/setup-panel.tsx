"use client";

import { useState } from "react";
import { Card } from "@/components/ds/card";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

/**
 * Guided-setup panel, following the SSIS setup pattern (commit 0317041):
 * the panel stays expanded while setup is incomplete — there is no
 * collapse control until then — and collapses to a one-line summary with
 * an Edit setup button once complete.
 *
 * The collapsed default is decided on mount. Completing setup during this
 * visit leaves the panel open so the confirmation stays visible; the
 * summary row is the default on the next visit.
 */
export function SetupPanel({
  title,
  description,
  complete,
  summary,
  panelId,
  children
}: {
  title: string;
  description?: string;
  complete: boolean;
  /** One-line summary shown when collapsed. */
  summary: string;
  panelId: string;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(!complete);

  if (!expanded) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            aria-controls={panelId}
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-accent"
          >
            Edit setup <ChevronDownIcon className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {complete ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-expanded={true}
            aria-controls={panelId}
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-accent"
          >
            Collapse <ChevronUpIcon className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      <div id={panelId} className="space-y-5">
        {children}
      </div>
    </Card>
  );
}
