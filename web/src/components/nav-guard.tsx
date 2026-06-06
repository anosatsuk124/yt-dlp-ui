"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

// A page (currently only Settings) registers a guard describing whether it has
// unsaved changes and how to save/discard them. Nav routes its clicks through
// `requestNavigate`, which pops a confirm modal when a dirty guard is active.

export interface NavGuard {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

interface NavGuardContextValue {
  requestNavigate: (href: string) => void;
  registerGuard: (guard: NavGuard | null) => void;
}

const NavGuardContext = createContext<NavGuardContextValue | null>(null);

export function NavGuardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const guardRef = useRef<NavGuard | null>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const registerGuard = useCallback((guard: NavGuard | null) => {
    guardRef.current = guard;
  }, []);

  const requestNavigate = useCallback(
    (href: string) => {
      const guard = guardRef.current;
      if (guard && guard.isDirty()) setPendingHref(href);
      else router.push(href);
    },
    [router],
  );

  const close = useCallback(() => setPendingHref(null), []);

  async function onSave() {
    const guard = guardRef.current;
    if (!guard) {
      close();
      return;
    }
    setBusy(true);
    let ok = false;
    try {
      ok = await guard.save();
    } finally {
      setBusy(false);
    }
    const href = pendingHref;
    setPendingHref(null);
    if (ok && href) router.push(href);
  }

  function onDiscard() {
    guardRef.current?.discard();
    const href = pendingHref;
    setPendingHref(null);
    if (href) router.push(href);
  }

  return (
    <NavGuardContext.Provider value={{ requestNavigate, registerGuard }}>
      {children}
      <Dialog open={pendingHref !== null} onOpenChange={o => { if (!o && !busy) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes on the Settings page. Save them before
              leaving, discard them, or stay on this page.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDiscard} disabled={busy}>
              Discard
            </Button>
            <Button onClick={onSave} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </NavGuardContext.Provider>
  );
}

export function useNavGuard(): NavGuardContextValue {
  const ctx = useContext(NavGuardContext);
  if (!ctx) throw new Error("useNavGuard must be used within a NavGuardProvider");
  return ctx;
}
