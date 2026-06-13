// A breadcrumb trail of wiki pages the user has walked through, so they can
// retrace their path. Kept in sessionStorage (per-tab, cleared when they return
// to the wiki index). Following a link appends; revisiting a page earlier in the
// trail truncates back to it.

export interface TrailEntry {
  slug: string;
  name: string;
}

const KEY = "meos-wiki-trail";

export function readWikiTrail(): TrailEntry[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TrailEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearWikiTrail(): void {
  sessionStorage.removeItem(KEY);
}

/** Record a visit and return the resulting trail. */
export function pushWikiTrail(slug: string, name: string): TrailEntry[] {
  const trail = readWikiTrail();
  const index = trail.findIndex((entry) => entry.slug === slug);
  let next: TrailEntry[];
  if (index >= 0) {
    next = trail.slice(0, index + 1);
    next[index] = { slug, name }; // refresh the name once it's known
  } else {
    next = [...trail, { slug, name }];
  }
  sessionStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
