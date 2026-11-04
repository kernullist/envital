import { save } from "@tauri-apps/plugin-dialog";
import { apiSaveExportFile, isTauriRuntime } from "../services/tauriClient";

export interface SaveFileResult {
  /** False when the user dismissed the save dialog. */
  saved: boolean;
  /** Human-readable destination, shown in the confirmation toast. */
  location: string;
  bytes: number;
}

/**
 * Where the native save dialog should open.
 *
 * Without a directory the dialog opens in the app's *working directory*, which is
 * `src-tauri/` while running `tauri dev` — not where anyone looks for an exported
 * report. Default to the OS downloads folder and fall back to the bare file name.
 */
async function resolveDefaultPath(defaultName: string): Promise<string> {
  try {
    const { downloadDir, join } = await import("@tauri-apps/api/path");
    return await join(await downloadDir(), defaultName);
  } catch {
    return defaultName;
  }
}

/**
 * Write exported text to a file the user picks.
 *
 * A plain `<a download>` link does nothing inside the Tauri webview (WebKitGTK
 * has no download manager configured), so inside the app we ask for a
 * destination with the native dialog and let the backend write it. A browser
 * tab previewing the UI still falls back to a normal download.
 *
 * The chosen name is used exactly as typed: appending the extension afterwards
 * could silently overwrite an existing `report.md` without the overwrite
 * confirmation the dialog already showed for the name the user saw.
 */
export async function saveTextFile(options: {
  defaultName: string;
  contents: string;
  filterName: string;
  extension: string;
  mimeType: string;
}): Promise<SaveFileResult> {
  const { defaultName, contents, filterName, extension, mimeType } = options;

  if (isTauriRuntime()) {
    const destination = await save({
      defaultPath: await resolveDefaultPath(defaultName),
      filters: [{ name: filterName, extensions: [extension] }],
    });
    if (!destination) {
      return { saved: false, location: "", bytes: 0 };
    }
    const outcome = await apiSaveExportFile(destination, contents);
    return { saved: true, location: outcome.path, bytes: outcome.bytes };
  }

  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = defaultName;
  // Detached anchors are ignored by some engines, and revoking the object URL in
  // the same tick can cancel the download; attach it and revoke on the next tick.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return {
    saved: true,
    location: `your downloads folder (${defaultName})`,
    bytes: blob.size,
  };
}
