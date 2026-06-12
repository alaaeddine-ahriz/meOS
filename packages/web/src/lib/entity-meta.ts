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
}

export const ENTITY_TYPE_ORDER = ["person", "project", "organisation", "concept", "place", "decision"];

export const ENTITY_TYPES: Record<string, EntityTypeMeta> = {
  person: { icon: User, singular: "person", plural: "people" },
  project: { icon: FolderKanban, singular: "project", plural: "projects" },
  organisation: { icon: Building2, singular: "organisation", plural: "organisations" },
  concept: { icon: Lightbulb, singular: "concept", plural: "concepts" },
  place: { icon: MapPin, singular: "place", plural: "places" },
  decision: { icon: Signpost, singular: "decision", plural: "decisions" },
};
