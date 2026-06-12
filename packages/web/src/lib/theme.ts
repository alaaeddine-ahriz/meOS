export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "meos-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function storedTheme(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function resolve(preference: ThemePreference): "light" | "dark" {
  return preference === "system" ? (media.matches ? "dark" : "light") : preference;
}

function apply(preference: ThemePreference): void {
  document.documentElement.classList.toggle("dark", resolve(preference) === "dark");
}

export function setTheme(preference: ThemePreference): void {
  if (preference === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, preference);
  apply(preference);
}

/** Apply the stored preference and track OS changes while it is "system". */
export function initTheme(): void {
  apply(storedTheme());
  media.addEventListener("change", () => {
    if (storedTheme() === "system") apply("system");
  });
}
