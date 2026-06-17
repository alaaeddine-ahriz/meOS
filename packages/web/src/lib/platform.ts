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

/**
 * Open a folder (or file) in the system file manager so its contents show —
 * desktop shell only. A plain browser can't open native paths, so this no-ops
 * there.
 */
export async function openFolder(path: string): Promise<void> {
  if (!isTauri) return;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path).catch((error: unknown) => {
    console.error(`open folder failed for ${path}:`, error);
  });
}

/** Open a URL in the system browser (desktop shell) or a new tab (browser). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url).catch((error: unknown) => {
      console.error(`open URL failed for ${url}:`, error);
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
