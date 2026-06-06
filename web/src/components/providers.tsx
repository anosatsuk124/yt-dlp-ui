"use client";

import type { ReactNode } from "react";
import { TabStateProvider } from "@/components/tab-state";
import { NavGuardProvider } from "@/components/nav-guard";

// Client-side providers shared by the whole app. Mounted in the root layout so
// the in-memory tab store and the navigation guard persist across client
// navigations between tabs.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <TabStateProvider>
      <NavGuardProvider>{children}</NavGuardProvider>
    </TabStateProvider>
  );
}
