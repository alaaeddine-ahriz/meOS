/**
 * Official multicolor brand logos for the external services meOS connects to,
 * as self-contained inline SVGs (no dependency, no network). Each accepts a
 * `className` so callers control sizing (e.g. `size-4`); the logo keeps its own
 * brand colors. `SERVICE_BRANDS` maps a connector source type
 * (`google:gmail` | `google:calendar` | `google:contacts`) to its label + logo,
 * so a wiki page can show which services reference an entity.
 */

import type { ReactElement } from "react";

interface LogoProps {
  className?: string;
}

/** Gmail — the multicolor envelope "M". */
export function GmailLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75L35 40h7c1.657 0 3-1.343 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon
        fill="#e53935"
        points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17"
      />
      <path
        fill="#c62828"
        d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859C9.132 8.301 8.228 8 7.298 8 4.924 8 3 9.924 3 12.298z"
      />
      <path
        fill="#fbc02d"
        d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341C38.868 8.301 39.772 8 40.702 8 43.076 8 45 9.924 45 12.298z"
      />
    </svg>
  );
}

/** Google Calendar — the colored calendar with the "31" mark. */
export function GoogleCalendarLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <rect width="22" height="22" x="13" y="13" fill="#fff" />
      <polygon
        fill="#1e88e5"
        points="25.68,20.92 26.688,22.36 28.272,21.208 28.272,29.56 30,29.56 30,18.616 28.56,18.616"
      />
      <path
        fill="#1e88e5"
        d="M22.943 23.745c.625-.574 1.013-1.37 1.013-2.249 0-1.747-1.533-3.168-3.417-3.168-1.602 0-2.972 1.009-3.33 2.453l1.657.421c.165-.664.868-1.146 1.673-1.146.942 0 1.709.646 1.709 1.44s-.767 1.44-1.709 1.44h-.997v1.728h.997c1.081 0 1.993.751 1.993 1.64 0 .904-.866 1.64-1.931 1.64-.962 0-1.784-.61-1.914-1.418l-1.682.276c.262 1.61 1.77 2.824 3.596 2.824 2.007 0 3.64-1.512 3.64-3.372 0-1.078-.55-2.12-1.388-2.81z"
      />
      <polygon fill="#fbc02d" points="34,42 14,42 13,38 14,34 34,34 35,38" />
      <polygon fill="#4caf50" points="38,34 42,34 42,14 38,13 34,14 34,34" />
      <path fill="#1e88e5" d="M34 14l1-4-1-4H9C7.343 6 6 7.343 6 9v25l4 1 4-1V14h20z" />
      <polygon fill="#e53935" points="34,34 34,42 42,34" />
      <path fill="#1565c0" d="M39 6h-5v8h8V9c0-1.657-1.343-3-3-3z" />
      <path fill="#2e7d32" d="M9 42h5v-8H6v5c0 1.657 1.343 3 3 3z" />
    </svg>
  );
}

/** Google Contacts — the blue person glyph. */
export function GoogleContactsLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#1a73e8"
        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
      />
      <rect width="2" height="2" x="2" y="6" fill="#ea4335" rx="0.5" />
      <rect width="2" height="2" x="2" y="11" fill="#34a853" rx="0.5" />
      <rect width="2" height="2" x="2" y="16" fill="#fbbc04" rx="0.5" />
    </svg>
  );
}

/** A service's display label + logo, keyed by connector source type. */
export interface ServiceBrand {
  label: string;
  Logo: (props: LogoProps) => ReactElement;
}

export const SERVICE_BRANDS: Record<string, ServiceBrand> = {
  "google:gmail": { label: "Gmail", Logo: GmailLogo },
  "google:calendar": { label: "Google Calendar", Logo: GoogleCalendarLogo },
  "google:contacts": { label: "Google Contacts", Logo: GoogleContactsLogo },
};

/** Stable display order for chips: Gmail, Calendar, Contacts. */
export const SERVICE_ORDER = ["google:gmail", "google:calendar", "google:contacts"] as const;
