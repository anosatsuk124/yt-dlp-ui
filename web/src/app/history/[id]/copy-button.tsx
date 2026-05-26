"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-auto px-2 py-0.5 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Older browsers / non-secure contexts: surface failure without
          // crashing — user can still select the <pre> manually.
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
