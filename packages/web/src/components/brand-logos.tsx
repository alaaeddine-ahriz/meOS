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

/** Anthropic — the wordmark's "A" glyph, inheriting the current text colour. */
export function AnthropicLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 46 32" className={className} fill="currentColor" aria-hidden="true">
      <path d="M32.73 0h-6.945L38.45 32h6.945L32.73 0ZM12.665 0 0 32h7.082l2.59-6.72h13.25l2.59 6.72h7.082L11.93 0h-.735Zm-.405 19.276 4.334-11.23 4.334 11.23h-8.668Z" />
    </svg>
  );
}

/** OpenAI — the monochrome blossom mark, inheriting the current text colour. */
export function OpenAILogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

/** Google — the multicolor "G". */
export function GoogleLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

/** Google Tasks — the blue check badge. */
export function GoogleTasksLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="20" fill="#1a73e8" />
      <path
        fill="none"
        stroke="#fff"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 24.5l6 6 12-13"
      />
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
  "google:tasks": { label: "Google Tasks", Logo: GoogleTasksLogo },
};

/** Stable display order for chips: Gmail, Calendar, Contacts, Tasks. */
export const SERVICE_ORDER = [
  "google:gmail",
  "google:calendar",
  "google:contacts",
  "google:tasks",
] as const;
