// Appearance preferences. Two orthogonal axes, persisted in localStorage and
// applied to <html>: light/dark mode (the .dark class) and color scheme
// (data-scheme). Everything else is stock shadcn. See index.css for the tokens.

export type ThemePreference = "light" | "dark" | "system";
export type Scheme = "normal" | "warm";

const MODE_KEY = "meos-theme";
const SCHEME_KEY = "meos-scheme";
// Legacy key from the old multi-palette system — a stored "warm" palette
// migrates to the warm scheme so existing installs keep their look.
const LEGACY_PALETTE_KEY = "meos-palette";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function storedTheme(): ThemePreference {
  const value = localStorage.getItem(MODE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function storedScheme(): Scheme {
  const value = localStorage.getItem(SCHEME_KEY);
  if (value === "warm" || value === "normal") return value;
  return localStorage.getItem(LEGACY_PALETTE_KEY) === "warm" ? "warm" : "normal";
}

function resolveMode(preference: ThemePreference): "light" | "dark" {
  return preference === "system" ? (media.matches ? "dark" : "light") : preference;
}

function applyMode(preference: ThemePreference): void {
  document.documentElement.classList.toggle("dark", resolveMode(preference) === "dark");
}

export function setTheme(preference: ThemePreference): void {
  if (preference === "system") localStorage.removeItem(MODE_KEY);
  else localStorage.setItem(MODE_KEY, preference);
  applyMode(preference);
}

export function setScheme(scheme: Scheme): void {
  localStorage.setItem(SCHEME_KEY, scheme);
  document.documentElement.dataset.scheme = scheme;
}

/** Apply both stored preferences and keep mode in sync with the OS while "system". */
export function initTheme(): void {
  applyMode(storedTheme());
  document.documentElement.dataset.scheme = storedScheme();
  media.addEventListener("change", () => {
    if (storedTheme() === "system") applyMode("system");
  });
}
