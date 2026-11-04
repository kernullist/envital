import { confirm } from "@tauri-apps/plugin-dialog";
import { isTauriRuntime } from "../services/tauriClient";

/**
 * Ask the user before an action that overwrites or deletes something.
 *
 * Inside the app this is the native dialog; a browser tab previewing the UI
 * falls back to `window.confirm`. Anything that goes wrong (no dialog support,
 * a rejected promise) counts as "no": a destructive action must never run just
 * because the question could not be shown.
 */
export async function confirmAction(
  message: string,
  options: {
    title?: string;
    okLabel?: string;
    cancelLabel?: string;
  } = {}
): Promise<boolean> {
  if (isTauriRuntime()) {
    try {
      return await confirm(message, {
        title: options.title ?? "Confirm",
        kind: "warning",
        okLabel: options.okLabel ?? "Continue",
        cancelLabel: options.cancelLabel ?? "Cancel",
      });
    } catch {
      return false;
    }
  }

  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(
      options.title ? `${options.title}\n\n${message}` : message
    );
  }
  return false;
}
