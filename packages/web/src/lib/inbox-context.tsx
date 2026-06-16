import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type IngestJob, type InboxItem } from "../api.js";

interface InboxState {
  items: InboxItem[];
  queuePending: number;
  /**
   * Retryable durable ingest jobs (#13), keyed by the inbox item they belong to,
   * so the Activity feed can offer a one-click "Retry" on a failed/dead-letter
   * ingest. Only `failed` and `dead-letter` jobs appear here.
   */
  retryableByInbox: Map<number, IngestJob>;
  /** Manually retry an ingest job; refreshes the inbox + job list on success. */
  retryJob: (jobId: number) => Promise<void>;
}

const InboxContext = createContext<InboxState>({
  items: [],
  queuePending: 0,
  retryableByInbox: new Map(),
  retryJob: async () => {},
});

/**
 * One source of truth for the inbox, polled once for the whole app. Both the
 * nav badge and the Activity feed read from here instead of each running their
 * own timer against /api/inbox. It also polls the durable ingest-job ledger
 * (#13) so a failed/dead-letter ingest can be retried from the feed.
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [queuePending, setQueuePending] = useState(0);
  const [retryableByInbox, setRetryableByInbox] = useState<Map<number, IngestJob>>(new Map());

  const refresh = useCallback(() => {
    api
      .getInbox()
      .then((r) => {
        setItems(r.items);
        setQueuePending(r.queuePending);
      })
      .catch(() => {});
    api
      .listIngestJobs()
      .then((r) => {
        const map = new Map<number, IngestJob>();
        for (const job of r.jobs) {
          if ((job.state === "failed" || job.state === "dead-letter") && job.inboxItemId != null) {
            map.set(job.inboxItemId, job);
          }
        }
        setRetryableByInbox(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const retryJob = useCallback(
    async (jobId: number) => {
      await api.retryIngestJob(jobId).catch(() => {});
      refresh();
    },
    [refresh],
  );

  return (
    <InboxContext.Provider value={{ items, queuePending, retryableByInbox, retryJob }}>
      {children}
    </InboxContext.Provider>
  );
}

export function useInbox(): InboxState {
  return useContext(InboxContext);
}
