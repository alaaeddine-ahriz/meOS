import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type InboxItem } from "../api.js";

interface InboxState {
  items: InboxItem[];
  queuePending: number;
}

const InboxContext = createContext<InboxState>({ items: [], queuePending: 0 });

/**
 * One source of truth for the inbox, polled once for the whole app. Both the
 * nav badge and the Activity feed read from here instead of each running their
 * own timer against /api/inbox.
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<InboxState>({ items: [], queuePending: 0 });

  useEffect(() => {
    const refresh = () =>
      api
        .getInbox()
        .then((r) => setState({ items: r.items, queuePending: r.queuePending }))
        .catch(() => {});
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  return <InboxContext.Provider value={state}>{children}</InboxContext.Provider>;
}

export function useInbox(): InboxState {
  return useContext(InboxContext);
}
