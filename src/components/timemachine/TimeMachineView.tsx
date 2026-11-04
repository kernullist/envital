import React, { useEffect, useState } from "react";
import {
  Camera,
  Clock,
  Download,
  GitCompare,
  History,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import { displayVariableValue } from "../../types/ipc";
import { confirmAction } from "../../utils/confirmAction";
import { saveTextFile } from "../../utils/saveFile";

export const TimeMachineView: React.FC = () => {
  const {
    snapshots,
    selectedSnapshotDiff,
    isLoadingDiff,
    isApplying,
    loadSnapshots,
    createManualSnapshot,
    selectSnapshotForDiff,
    restoreSnapshot,
    deleteSnapshot,
    exportEnvironmentText,
    importEnvironmentJson,
    addToast,
  } = useEnvStore();

  const [manualTitle, setManualTitle] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [viewMode, setViewMode] = useState<"structured" | "unified">(
    "structured"
  );

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

  const handleCreateManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualTitle.trim()) return;
    await createManualSnapshot(
      manualTitle.trim(),
      manualDesc.trim() || "User manual snapshot"
    );
    setManualTitle("");
    setManualDesc("");
  };

  const handleExport = async (format: "json" | "dotenv") => {
    try {
      const content = await exportEnvironmentText(format);
      const isDotenv = format === "dotenv";
      const result = await saveTextFile({
        defaultName: isDotenv ? "env-doctor-export.env" : "env-doctor-export.json",
        contents: content,
        filterName: isDotenv ? "Dotenv" : "JSON",
        extension: isDotenv ? "env" : "json",
        mimeType: isDotenv ? "text/plain" : "application/json",
      });
      if (!result.saved) {
        addToast("info", "Export Cancelled", "No file was written.");
        return;
      }
      addToast(
        "success",
        `${format.toUpperCase()} Export Complete`,
        `${result.location} (${result.bytes} bytes)`
      );
    } catch (err) {
      addToast("error", "Export Failed", String(err));
    }
  };

  const handleRestore = async () => {
    if (!selectedSnapshotDiff) return;
    const confirmed = await confirmAction(
      `Restore the PATH and environment variables from "${selectedSnapshotDiff.snapshot_title}"?\n\n` +
        "This overwrites the current configuration. A safety snapshot of the current state is taken first, " +
        "but apps that are already running keep the old environment until they are restarted.",
      { title: "Restore snapshot", okLabel: "Restore" }
    );
    if (!confirmed) return;
    await restoreSnapshot(selectedSnapshotDiff.snapshot_id, true);
  };

  const handleDelete = async (snapshotId: string, title: string) => {
    const confirmed = await confirmAction(
      `Delete the snapshot "${title}"? This cannot be undone.`,
      { title: "Delete snapshot", okLabel: "Delete" }
    );
    if (!confirmed) return;
    await deleteSnapshot(snapshotId);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        importEnvironmentJson(reader.result);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-5 space-y-4">
      {/* Header & Export/Import Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <History className="w-5 h-5 text-sky-400" />
            <span>🕒 Time-Machine Snapshots &amp; Git Diff Rollback</span>
          </h1>
          <p className="text-xs text-slate-400">
            Every state prior to clicking [Apply] is automatically backed up to a local SQLite database so you can compare via Git Diff and roll back in 1 second.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleExport("json")}
            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 transition"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span>Export JSON</span>
          </button>
          <button
            onClick={() => handleExport("dotenv")}
            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 transition"
          >
            <Download className="w-3.5 h-3.5 text-sky-400" />
            <span>Export .env</span>
          </button>
          <label className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 cursor-pointer transition">
            <Upload className="w-3.5 h-3.5 text-amber-400" />
            <span>Import JSON</span>
            <input
              type="file"
              accept=".json"
              onChange={handleImportFile}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {/* Create Manual Snapshot Form */}
      <form
        onSubmit={handleCreateManual}
        className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center gap-2.5"
      >
        <Camera className="w-4 h-4 text-sky-400 shrink-0" />
        <input
          type="text"
          value={manualTitle}
          onChange={(e) => setManualTitle(e.target.value)}
          placeholder="Snapshot title (e.g., Before installing CUDA 12.4)"
          className="flex-1 min-w-[200px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
        />
        <input
          type="text"
          value={manualDesc}
          onChange={(e) => setManualDesc(e.target.value)}
          placeholder="Notes (optional)"
          className="flex-1 min-w-[180px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          className="px-3.5 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs transition"
        >
          + Take Snapshot Now
        </button>
      </form>

      {/* Main Split: Left Timeline + Right Diff Viewer */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 overflow-hidden">
        {/* Snapshot Timeline */}
        <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-slate-900/60 overflow-y-auto p-3 space-y-2">
          <div className="text-xs font-bold text-slate-300 px-1 pb-1">
            Snapshot History ({snapshots.length})
          </div>

          {snapshots.map((snap) => {
            const isSelected = selectedSnapshotDiff?.snapshot_id === snap.id;
            return (
              <div
                key={snap.id}
                onClick={() => selectSnapshotForDiff(snap.id)}
                className={`p-3 rounded-xl border cursor-pointer transition space-y-1.5 ${
                  isSelected
                    ? "bg-slate-800/90 border-sky-500/60 shadow-md"
                    : "bg-slate-950/60 hover:bg-slate-900 border-slate-800"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-100 truncate">
                    {snap.title}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
                      snap.is_automatic
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                        : "bg-sky-500/15 text-sky-300 border-sky-500/30"
                    }`}
                  >
                    {snap.is_automatic ? "Auto Backup" : "Manual"}
                  </span>
                </div>

                {snap.description && (
                  <p className="text-[11px] text-slate-400 line-clamp-2">
                    {snap.description}
                  </p>
                )}

                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                  <span className="flex items-center gap-1 font-mono">
                    <Clock className="w-3 h-3" /> {snap.created_at}
                  </span>
                  <span>
                    {snap.path_count} PATHs · {snap.var_count} Vars
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Git Diff Viewer & Rollback Panel */}
        <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-slate-900/60 flex flex-col overflow-hidden">
          {isLoadingDiff || !selectedSnapshotDiff ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
              {isLoadingDiff
                ? "Computing snapshot diff..."
                : "Select a snapshot on the left to inspect its diff."}
            </div>
          ) : (
            <>
              <div className="p-3.5 border-b border-slate-800 bg-slate-950/70 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-100">
                    <GitCompare className="w-4 h-4 text-sky-400" />
                    <span>{selectedSnapshotDiff.snapshot_title}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    Comparing Snapshot ({selectedSnapshotDiff.created_at}) vs Current Staged State
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-[11px]">
                    <button
                      onClick={() => setViewMode("structured")}
                      className={`px-2 py-1 rounded ${
                        viewMode === "structured"
                          ? "bg-slate-800 text-slate-100 font-semibold"
                          : "text-slate-400"
                      }`}
                    >
                      Structured Diff
                    </button>
                    <button
                      onClick={() => setViewMode("unified")}
                      className={`px-2 py-1 rounded ${
                        viewMode === "unified"
                          ? "bg-slate-800 text-slate-100 font-semibold"
                          : "text-slate-400"
                      }`}
                    >
                      Git Unified Diff
                    </button>
                  </div>

                  <button
                    onClick={handleRestore}
                    disabled={isApplying}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Restore in 1 Second</span>
                  </button>

                  <button
                    onClick={() =>
                      handleDelete(
                        selectedSnapshotDiff.snapshot_id,
                        selectedSnapshotDiff.snapshot_title
                      )
                    }
                    className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition"
                    title="Delete snapshot"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
                {viewMode === "unified" ? (
                  <pre className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs text-slate-200 overflow-x-auto whitespace-pre-wrap">
                    {selectedSnapshotDiff.unified_diff ||
                      "No differences detected (snapshot matches current state)."}
                  </pre>
                ) : (
                  <>
                    {selectedSnapshotDiff.var_diffs.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-xs font-semibold text-slate-300">
                          Variable Differences ({selectedSnapshotDiff.var_diffs.length})
                          <span className="ml-2 font-normal text-[11px] text-slate-500">
                            Values of credential-like names are hidden.
                          </span>
                        </div>
                        <div className="rounded-xl border border-slate-800 bg-slate-950 divide-y divide-slate-900 font-mono text-xs">
                          {selectedSnapshotDiff.var_diffs.map((vd) => (
                            <div
                              key={`${vd.scope_label}-${vd.key}`}
                              className="p-2.5"
                            >
                              <div className="font-bold text-slate-200">
                                [{vd.scope_label}] {vd.key} ({vd.change_type})
                              </div>
                              {vd.old_value !== null && (
                                <div className="text-rose-400 break-all">
                                  - Snapshot: {displayVariableValue(vd.key, vd.old_value)}
                                </div>
                              )}
                              {vd.new_value !== null && (
                                <div className="text-emerald-400 break-all">
                                  + Current: {displayVariableValue(vd.key, vd.new_value)}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <div className="text-xs font-semibold text-slate-300">
                        PATH Line-by-Line Comparison
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950 divide-y divide-slate-900/70 font-mono text-xs">
                        {selectedSnapshotDiff.path_diffs.map((line, idx) => (
                          <div
                            key={idx}
                            className={`px-3 py-1 flex items-center gap-2.5 ${
                              line.change_type === "added"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : line.change_type === "removed"
                                  ? "bg-rose-500/15 text-rose-300"
                                  : "text-slate-400"
                            }`}
                          >
                            <span className="w-5 text-right text-[10px] text-slate-500 shrink-0">
                              {line.old_index ?? ""}
                            </span>
                            <span className="w-5 text-right text-[10px] text-slate-500 shrink-0">
                              {line.new_index ?? ""}
                            </span>
                            <span className="w-3 font-bold shrink-0">
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
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
