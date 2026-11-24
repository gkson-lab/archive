import { inApp } from "./api";

/** native folder/file picker in the app. in a browser there's no path access, so we ask. */
export async function pickPaths(opts: { directory: boolean; multiple?: boolean; title?: string }): Promise<string[] | null> {
  if (inApp) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: opts.directory, multiple: opts.multiple ?? false, title: opts.title });
    if (!r) return null;
    return Array.isArray(r) ? r : [r];
  }
  return null;
}

export async function openUrl(url: string) {
  if (inApp) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export async function reveal(path: string) {
  if (inApp) {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  }
}

export async function openPath(path: string) {
  if (inApp) {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  }
}

/** listen for files dropped onto the app window from the os (real paths, app only) */
export async function onNativeDrop(cb: (paths: string[], pos: { x: number; y: number }) => void, hover: (pos: { x: number; y: number } | null) => void): Promise<() => void> {
  if (!inApp) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const un = await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload as any;
    const ratio = window.devicePixelRatio || 1;
    const pos = p.position ? { x: p.position.x / ratio, y: p.position.y / ratio } : { x: 0, y: 0 };
    if (p.type === "over" || p.type === "enter") hover(pos);
    else if (p.type === "leave") hover(null);
    else if (p.type === "drop") {
      hover(null);
      cb(p.paths ?? [], pos);
    }
  });
  return un;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const mod = isMac ? "⌘" : "ctrl";
