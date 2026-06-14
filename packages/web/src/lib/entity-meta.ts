import {
  Building2,
  FolderKanban,
  Lightbulb,
  MapPin,
  Signpost,
  User,
  type LucideIcon,
} from "lucide-react";

export interface EntityTypeMeta {
  icon: LucideIcon;
  singular: string;
  plural: string;
  /** Mid-tone hue that reads on both the cream and dark themes (used by the graph). */
  color: string;
}

export const ENTITY_TYPE_ORDER = ["person", "project", "organisation", "concept", "place", "decision"];

export const ENTITY_TYPES: Record<string, EntityTypeMeta> = {
  person: { icon: User, singular: "person", plural: "people", color: "#c08a3e" },
  project: { icon: FolderKanban, singular: "project", plural: "projects", color: "#6f8f55" },
  organisation: { icon: Building2, singular: "organisation", plural: "organisations", color: "#5f7d8c" },
  concept: { icon: Lightbulb, singular: "concept", plural: "concepts", color: "#9a6a8f" },
  place: { icon: MapPin, singular: "place", plural: "places", color: "#4f8a7b" },
  decision: { icon: Signpost, singular: "decision", plural: "decisions", color: "#b1583f" },
};

/** Mid-tone hue for an entity type, falling back to a neutral for unknown types. */
export const FALLBACK_COLOR = "#8f8779";
export function typeColor(type: string): string {
  return ENTITY_TYPES[type]?.color ?? FALLBACK_COLOR;
}
