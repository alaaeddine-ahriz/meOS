/** True when running inside the Tauri desktop shell rather than a browser. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True for paths Finder can actually reveal (absolute, not a bare basename). */
export function isRevealablePath(path: string | null): path is string {
  return !!path && path.startsWith("/");
}

/** Reveal a file in Finder / the system file manager (desktop shell only). */
export async function revealInFinder(path: string): Promise<void> {
  if (!isTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path).catch((error: unknown) => {
    console.error(`reveal in Finder failed for ${path}:`, error);
  });
}
