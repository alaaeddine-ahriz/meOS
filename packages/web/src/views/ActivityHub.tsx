import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Page, PageHeader } from "@/components/Page";
import { HubTab, HubTabs } from "@/components/HubTabs";
import { api } from "../api.js";
import { ActivityView } from "./ActivityView.js";
import { ContradictionsView } from "./ContradictionsView.js";
import { DigestView } from "./DigestView.js";
import { InboxView } from "./InboxView.js";

type HubTabId = "inbox" | "runs" | "conflicts" | "digest";
const TAB_IDS: HubTabId[] = ["inbox", "runs", "conflicts", "digest"];

/**
 * The agent-oversight hub: everything about what's coming in and what the
 * maintainer is doing, gathered behind one nav slot. Each section is the
 * existing view rendered embedded (no header of its own) under the shared shell.
 */
export function ActivityHub() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: HubTabId = TAB_IDS.includes(raw as HubTabId) ? (raw as HubTabId) : "inbox";

  const [queuePending, setQueuePending] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);

  // Poll the inbox so the Inbox tab carries a live "absorbing" count.
  useEffect(() => {
    const poll = () => api.getInbox().then((r) => setQueuePending(r.queuePending)).catch(() => {});
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  // Open conflicts + likely duplicates feed the Conflicts tab badge.
  useEffect(() => {
    Promise.all([
      api.getContradictions().then((r) => r.contradictions.length).catch(() => 0),
      api.getDuplicates().then((r) => r.duplicates.length).catch(() => 0),
    ]).then(([c, d]) => setConflictCount(c + d));
  }, [tab]);

  const setTab = (next: HubTabId) => {
    const params2 = new URLSearchParams(params);
    params2.set("tab", next);
    setParams(params2, { replace: true });
  };

  return (
    <Page>
      <PageHeader
        title="Activity"
        description="What's coming in, what the maintainer is doing, and what needs your call."
      />

      <HubTabs className="rise mt-8">
        <HubTab active={tab === "inbox"} count={queuePending} onClick={() => setTab("inbox")}>
          Inbox
        </HubTab>
        <HubTab active={tab === "runs"} onClick={() => setTab("runs")}>
          Runs
        </HubTab>
        <HubTab active={tab === "conflicts"} count={conflictCount} onClick={() => setTab("conflicts")}>
          Conflicts
        </HubTab>
        <HubTab active={tab === "digest"} onClick={() => setTab("digest")}>
          Digest
        </HubTab>
      </HubTabs>

      {tab === "inbox" && <InboxView embedded />}
      {tab === "runs" && <ActivityView embedded />}
      {tab === "conflicts" && <ContradictionsView embedded />}
      {tab === "digest" && <DigestView embedded />}
    </Page>
  );
}
