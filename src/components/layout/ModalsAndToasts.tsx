import React, { useState } from "react";
import {
  AlertOctagon,
  CheckCircle2,
  GitCompare,
  Info,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import { displayVariableValue, isWindowsPlatform } from "../../types/ipc";

export const ModalsAndToasts: React.FC = () => {
  const {
    safeGuardWarning,
    closeSafeGuardModal,
    isApplyModalOpen,
    closeApplyModal,
    applyDiffPreview,
    isApplying,
    confirmApplyChanges,
    toasts,
    dismissToast,
  } = useEnvStore();

  const [snapshotTitle, setSnapshotTitle] = useState(
    "Automatic Backup Before Apply"
  );
  const [allowUac, setAllowUac] = useState(true);

  return (
    <>
      {/* Section 9.1 Safe Guard Modal */}
      {safeGuardWarning && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-rose-500/50 shadow-2xl overflow-hidden">
            <div className="p-4 bg-rose-500/15 border-b border-rose-500/30 flex items-center justify-between">
              <div className="flex items-center gap-2 text-rose-300 font-bold text-sm">
                <ShieldAlert className="w-5 h-5 text-rose-400" />
                <span>Critical System PATH Blocked (Safe Guard)</span>
              </div>
              <button
                onClick={closeSafeGuardModal}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs text-slate-300 leading-relaxed">
              <p>{safeGuardWarning.reason}</p>
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-rose-300 break-all">
                {safeGuardWarning.rawPath}
              </div>
              <p className="text-slate-400">
                Removing <code className="text-slate-200">System32</code> on
                Windows or <code className="text-slate-200">/usr/bin</code>,{" "}
                <code className="text-slate-200">/bin</code> on Linux breaks OS
                commands and shell sessions. Safe Guard has prevented this deletion.
              </p>
            </div>
            <div className="p-3.5 bg-slate-950/80 border-t border-slate-800 flex justify-end">
              <button
                onClick={closeSafeGuardModal}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100 transition"
              >
                Understood (Keep Protected)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 2 Staged Changes Diff Preview & Apply Modal */}
      {isApplyModalOpen && applyDiffPreview && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[85vh] rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <GitCompare className="w-5 h-5 text-emerald-400" />
                <div>
                  <h3 className="text-sm font-bold text-slate-100">
                    Review Staged Diff &amp; Apply Changes
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    An automatic snapshot of your current state will be saved to Time Machine (SQLite) before applying.
                  </p>
                </div>
              </div>
              <button
                onClick={closeApplyModal}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Auto Snapshot Title & UAC Toggle */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-xl bg-slate-950/90 border border-slate-800">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Automatic Backup Snapshot Title
                  </label>
                  <input
                    type="text"
                    value={snapshotTitle}
                    onChange={(e) => setSnapshotTitle(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                {isWindowsPlatform() ? (
                  <div className="flex items-center pt-4">
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={allowUac}
                        onChange={(e) => setAllowUac(e.target.checked)}
                        className="rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
                      />
                      <span>
                        Allow UAC administrator elevation prompt if System (HKLM) variables changed
                      </span>
                    </label>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400 pt-4">
                    Linux: no elevation prompt is needed. Changes are written to{" "}
                    <code className="text-slate-300">~/.config/env-doctor/env.sh</code>{" "}
                    and loaded by new shells.
                  </p>
                )}
              </div>

              {/* Variable Diffs */}
              {applyDiffPreview.var_diffs.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-slate-300">
                    Environment Variable Changes ({applyDiffPreview.var_diffs.length})
                    <span className="ml-2 font-normal text-[11px] text-slate-500">
                      Values of credential-like names are hidden.
                    </span>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden divide-y divide-slate-800/80 font-mono text-xs">
                    {applyDiffPreview.var_diffs.map((vd) => (
                      <div key={`${vd.scope_label}-${vd.key}`} className="p-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                            {vd.scope_label}
                          </span>
                          <span className="font-bold text-slate-200">
                            {vd.key}
                          </span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              vd.change_type === "added"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : vd.change_type === "removed"
                                  ? "bg-rose-500/20 text-rose-300"
                                  : "bg-amber-500/20 text-amber-300"
                            }`}
                          >
                            {vd.change_type.toUpperCase()}
                          </span>
                        </div>
                        {vd.old_value !== null && (
                          <div className="text-rose-400 mt-1 break-all">
                            - {displayVariableValue(vd.key, vd.old_value)}
                          </div>
                        )}
                        {vd.new_value !== null && (
                          <div className="text-emerald-400 mt-0.5 break-all">
                            + {displayVariableValue(vd.key, vd.new_value)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* PATH Diffs */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-slate-300">
                  PATH Entry Diff Comparison
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950 max-h-72 overflow-y-auto font-mono text-xs divide-y divide-slate-900">
                  {applyDiffPreview.path_diffs.map((line, idx) => (
                    <div
                      key={idx}
                      className={`px-3 py-1 flex items-center gap-3 ${
                        line.change_type === "added"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : line.change_type === "removed"
                            ? "bg-rose-500/15 text-rose-300 line-through"
                            : "text-slate-400"
                      }`}
                    >
                      <span className="w-5 text-right text-[10px] text-slate-500 shrink-0">
                        {line.old_index ?? ""}
                      </span>
                      <span className="w-5 text-right text-[10px] text-slate-500 shrink-0">
                        {line.new_index ?? ""}
                      </span>
                      <span className="w-3 shrink-0 font-bold">
                        {line.change_type === "added"
                          ? "+"
                          : line.change_type === "removed"
                            ? "-"
                            : " "}
                      </span>
                      <span className="break-all">{line.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-950/90 border-t border-slate-800 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                {isWindowsPlatform() ? (
                  <>
                    Windows: Preserves{" "}
                    <code className="text-slate-300">REG_EXPAND_SZ</code> &amp; broadcasts{" "}
                    <code className="text-slate-300">WM_SETTINGCHANGE</code>{" "}
                    automatically
                  </>
                ) : (
                  <>
                    Linux: writes <code className="text-slate-300">env.sh</code> plus{" "}
                    <code className="text-slate-300">~/.config/environment.d</code>; already-open
                    shells keep the old PATH until restarted
                  </>
                )}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={closeApplyModal}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={() => confirmApplyChanges(snapshotTitle, allowUac)}
                  disabled={isApplying}
                  className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {isApplying
                      ? "Saving Snapshot & Applying..."
                      : "Save Snapshot & Apply Now"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Toasts */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto p-3 rounded-xl border shadow-xl backdrop-blur-md flex items-start gap-2.5 text-xs transition-all ${
              t.type === "success"
                ? "bg-slate-900/95 border-emerald-500/40 text-emerald-200"
                : t.type === "error"
                  ? "bg-slate-900/95 border-rose-500/40 text-rose-200"
                  : t.type === "warning"
                    ? "bg-slate-900/95 border-amber-500/40 text-amber-200"
                    : "bg-slate-900/95 border-sky-500/40 text-sky-200"
            }`}
          >
            {t.type === "success" && (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            )}
            {t.type === "error" && (
              <AlertOctagon className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            )}
            {t.type === "warning" && (
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            )}
            {t.type === "info" && (
              <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{t.title}</div>
              {t.detail && (
                <div className="text-[11px] text-slate-300 mt-0.5 break-words">
                  {t.detail}
                </div>
              )}
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              className="text-slate-400 hover:text-slate-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
};
