import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Page, PageHeader } from "@/components/Page";
import { HubTab, HubTabs } from "@/components/HubTabs";
import { api } from "../api.js";
import { ActivityView } from "./ActivityView.js";
import { ContradictionsView } from "./ContradictionsView.js";
import { DigestView } from "./DigestView.js";

type HubTabId = "feed" | "review" | "digest";
const TAB_IDS: HubTabId[] = ["feed", "review", "digest"];

// Older deep-links used per-section tabs (inbox/runs/conflicts); fold them into the new ones.
const TAB_ALIASES: Record<string, HubTabId> = {
  inbox: "feed",
  runs: "feed",
  conflicts: "review",
};

/**
 * The agent-oversight hub, in three slots: a live Feed of documents landing and
 * the pages the maintainer rewrites in response, a Review queue of duplicates
 * and conflicting claims for you to decide, and the daily Digest.
 */
export function ActivityHub() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: HubTabId = TAB_IDS.includes(raw as HubTabId)
    ? (raw as HubTabId)
    : TAB_ALIASES[raw ?? ""] ?? "feed";

  const [reviewCount, setReviewCount] = useState(0);

  // Open conflicts + likely duplicates feed the Review tab badge. The count is
  // the same on every tab, so fetch it once on mount rather than on each switch.
  useEffect(() => {
    Promise.all([
      api.getContradictions().then((r) => r.contradictions.length).catch(() => 0),
      api.getDuplicates().then((r) => r.duplicates.length).catch(() => 0),
    ]).then(([c, d]) => setReviewCount(c + d));
  }, []);

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
        <HubTab active={tab === "feed"} onClick={() => setTab("feed")}>
          Feed
        </HubTab>
        <HubTab active={tab === "review"} count={reviewCount} onClick={() => setTab("review")}>
          Review
        </HubTab>
        <HubTab active={tab === "digest"} onClick={() => setTab("digest")}>
          Digest
        </HubTab>
      </HubTabs>

      {tab === "feed" && <ActivityView embedded />}
      {tab === "review" && <ContradictionsView embedded />}
      {tab === "digest" && <DigestView embedded />}
    </Page>
  );
}
