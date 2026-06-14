// Appearance preferences. Orthogonal axes persisted in localStorage and applied
// to <html>: light/dark mode (a class), and palette / font / density / width /
// motion (data-attributes the stylesheet keys off). See index.css for the tokens.

export type ThemePreference = "light" | "dark" | "system";
export type Palette = "warm" | "neutral" | "cool";
export type FontPreset = "editorial" | "clean" | "literary" | "mono";
export type Density = "spaced" | "compact";
export type Width = "readable" | "full";
export type Motion = "full" | "reduced";

const MODE_KEY = "meos-theme";
const PALETTE_KEY = "meos-palette";
const FONT_KEY = "meos-font";
const DENSITY_KEY = "meos-density";
const WIDTH_KEY = "meos-width";
const MOTION_KEY = "meos-motion";

const media = window.matchMedia("(prefers-color-scheme: dark)");

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function storedTheme(): ThemePreference {
  const value = localStorage.getItem(MODE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function storedPalette(): Palette {
  return read(PALETTE_KEY, ["warm", "neutral", "cool"] as const, "warm");
}

export function storedFont(): FontPreset {
  return read(FONT_KEY, ["editorial", "clean", "literary", "mono"] as const, "editorial");
}

export function storedDensity(): Density {
  return read(DENSITY_KEY, ["spaced", "compact"] as const, "spaced");
}

export function storedWidth(): Width {
  return read(WIDTH_KEY, ["readable", "full"] as const, "readable");
}

export function storedMotion(): Motion {
  return read(MOTION_KEY, ["full", "reduced"] as const, "full");
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

export function setPalette(palette: Palette): void {
  localStorage.setItem(PALETTE_KEY, palette);
  document.documentElement.dataset.palette = palette;
}

export function setFont(font: FontPreset): void {
  localStorage.setItem(FONT_KEY, font);
  document.documentElement.dataset.font = font;
}

export function setDensity(density: Density): void {
  localStorage.setItem(DENSITY_KEY, density);
  document.documentElement.dataset.density = density;
}

export function setWidth(width: Width): void {
  localStorage.setItem(WIDTH_KEY, width);
  document.documentElement.dataset.width = width;
}

export function setMotion(motion: Motion): void {
  localStorage.setItem(MOTION_KEY, motion);
  document.documentElement.dataset.motion = motion;
}

/** Apply every stored preference and keep mode in sync with the OS while "system". */
export function initTheme(): void {
  const root = document.documentElement;
  applyMode(storedTheme());
  root.dataset.palette = storedPalette();
  root.dataset.font = storedFont();
  root.dataset.density = storedDensity();
  root.dataset.width = storedWidth();
  root.dataset.motion = storedMotion();
  media.addEventListener("change", () => {
    if (storedTheme() === "system") applyMode("system");
  });
}
