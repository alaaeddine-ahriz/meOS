import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Page, PageBody, PageHeader } from "@/components/Page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
 * and conflicting claims, and the daily Digest. Health moved out to its own
 * consolidated section at /sources?tab=health — old ?tab=health links redirect.
 */
export function ActivityHub() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get("tab");

  // Health is now a single section under Sources; send stale deep-links there.
  useEffect(() => {
    if (raw === "health") navigate("/sources?tab=health", { replace: true });
  }, [raw, navigate]);

  const tab: HubTabId = TAB_IDS.includes(raw as HubTabId)
    ? (raw as HubTabId)
    : (TAB_ALIASES[raw ?? ""] ?? "feed");

  const [reviewCount, setReviewCount] = useState(0);

  // Open conflicts + likely duplicates feed the Review tab badge. The count is
  // the same on every tab, so fetch it once on mount rather than on each switch.
  useEffect(() => {
    Promise.all([
      api
        .getContradictions()
        .then((r) => r.contradictions.length)
        .catch(() => 0),
      api
        .getDuplicates()
        .then((r) => r.duplicates.length)
        .catch(() => 0),
    ]).then(([c, d]) => setReviewCount(c + d));
  }, []);

  const setTab = (next: string) => {
    const params2 = new URLSearchParams(params);
    params2.set("tab", next);
    setParams(params2, { replace: true });
  };

  const tabs = (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="feed">Feed</TabsTrigger>
        <TabsTrigger value="review">
          Review
          {reviewCount > 0 && (
            <span className="tabular-nums text-muted-foreground">{reviewCount}</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="digest">Digest</TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    <Page>
      <PageHeader
        title="Activity"
        description="What's coming in, what the maintainer is doing, and what needs your call."
        actions={tabs}
      />
      <PageBody>
        {tab === "feed" && <ActivityView embedded />}
        {tab === "review" && <ContradictionsView embedded />}
        {tab === "digest" && <DigestView embedded />}
      </PageBody>
    </Page>
  );
}
