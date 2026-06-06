"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

// In-memory, per-tab state store. The provider lives in the root layout, which
// Next.js keeps mounted across client navigations, so values written here
// survive switching between the route-backed "tabs" even though each page
// component unmounts/remounts. State is intentionally NOT persisted — a full
// page reload starts fresh.

type Listener = () => void;

interface TabStore {
  has(key: string): boolean;
  init<T>(key: string, initial: T | (() => T)): void;
  get<T>(key: string): T;
  set<T>(key: string, action: SetStateAction<T>): void;
  subscribe(key: string, cb: Listener): () => void;
  /** Returns true only the first time it is called for `key` (per provider lifetime). */
  claimSeed(key: string): boolean;
}

function createStore(): TabStore {
  const values = new Map<string, unknown>();
  const seeded = new Set<string>();
  const listeners = new Map<string, Set<Listener>>();

  return {
    has(key) {
      return values.has(key);
    },
    init(key, initial) {
      if (values.has(key)) return;
      values.set(key, typeof initial === "function" ? (initial as () => unknown)() : initial);
    },
    get(key) {
      return values.get(key) as never;
    },
    set(key, action) {
      const prev = values.get(key);
      const next =
        typeof action === "function"
          ? (action as (p: unknown) => unknown)(prev)
          : action;
      if (Object.is(prev, next)) return;
      values.set(key, next);
      listeners.get(key)?.forEach(cb => cb());
    },
    subscribe(key, cb) {
      let subs = listeners.get(key);
      if (!subs) {
        subs = new Set();
        listeners.set(key, subs);
      }
      subs.add(cb);
      return () => {
        subs!.delete(cb);
      };
    },
    claimSeed(key) {
      if (seeded.has(key)) return false;
      seeded.add(key);
      return true;
    },
  };
}

const TabStoreContext = createContext<TabStore | null>(null);

export function TabStateProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<TabStore>();
  if (!storeRef.current) storeRef.current = createStore();
  return (
    <TabStoreContext.Provider value={storeRef.current}>
      {children}
    </TabStoreContext.Provider>
  );
}

function useStore(): TabStore {
  const store = useContext(TabStoreContext);
  if (!store) throw new Error("tab-state hooks must be used within a TabStateProvider");
  return store;
}

/**
 * Drop-in replacement for `useState` whose value is kept in the shared tab
 * store under `key`. On remount it returns the preserved value instead of
 * re-initializing. Supports functional updates.
 */
export function useTabState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const store = useStore();
  // Lazy-init once; idempotent across remounts and Strict-Mode double render.
  if (!store.has(key)) store.init(key, initial);

  const subscribe = useCallback((cb: Listener) => store.subscribe(key, cb), [store, key]);
  const getSnapshot = useCallback(() => store.get<T>(key), [store, key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    action => store.set<T>(key, action),
    [store, key],
  );

  return [value, setValue];
}

/**
 * Runs `fn` exactly once per provider lifetime, keyed by `seedKey`. Use for the
 * "fetch defaults → seed input state" effects that must NOT re-run on every
 * remount (which would clobber preserved input). `fn` should write results via
 * the passed store's `set`, so a write that lands after the page unmounts still
 * reaches the store, and a write mid-mount notifies the live component.
 */
export function useSeedOnce(seedKey: string, fn: (store: TabStore) => void): void {
  const store = useStore();
  useEffect(() => {
    if (!store.claimSeed(seedKey)) return;
    fn(store);
    // Intentionally one-shot per provider lifetime; `fn` is excluded on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, seedKey]);
}

// Stable key names (avoid typos across pages).
export const TAB_KEYS = {
  queue: {
    urls: "queue.urls",
    selections: "queue.selections",
    compat: "queue.compat",
    extraArgs: "queue.extraArgs",
    auth: "queue.auth",
    seed: "queue.seed",
  },
  settings: {
    defaultFormat: "settings.defaultFormat",
    defaultContainer: "settings.defaultContainer",
    defaultCompat: "settings.defaultCompat",
    maxParallel: "settings.maxParallel",
    downloadDir: "settings.downloadDir",
    mega: "settings.mega",
    baseline: "settings.baseline",
    loading: "settings.loading",
    seed: "settings.seed",
  },
  auth: {
    domain: "auth.domain",
    form: "auth.form",
    editing: "auth.editing",
  },
  cookies: {
    domain: "cookies.domain",
  },
  certs: {
    name: "certs.name",
  },
} as const;
