import React, { useState } from "react";
import {
  ArrowUp,
  CheckCircle2,
  RefreshCw,
  Search,
  Terminal,
  Zap,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import { formatScopeInfo } from "../../types/ipc";

const DEV_TOOL_NAMES = new Set([
  "python",
  "python3",
  "pip",
  "pip3",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "java",
  "javac",
  "go",
  "rustc",
  "cargo",
  "git",
  "gcc",
  "g++",
  "clang",
  "cmake",
  "make",
  "dotnet",
  "ruby",
  "php",
  "curl",
  "docker",
  "kubectl",
  "uv",
  "pwsh",
]);

export const ShadowingView: React.FC = () => {
  const {
    conflicts,
    pathEntries,
    globalSearch,
    isLoading,
    refreshDiagnostics,
    promoteBinaryInstance,
    selectPathEntry,
  } = useEnvStore();

  const [onlyDevTools, setOnlyDevTools] = useState(false);
  const [localQuery, setLocalQuery] = useState("");

  const combinedQuery = (localQuery || globalSearch).trim().toLowerCase();

  const filteredConflicts = conflicts.filter((c) => {
    if (onlyDevTools && !DEV_TOOL_NAMES.has(c.binary_name.toLowerCase())) {
      return false;
    }
    if (!combinedQuery) return true;
    return (
      c.binary_name.toLowerCase().includes(combinedQuery) ||
      c.locations.some(
        (l) =>
          l.full_path.toLowerCase().includes(combinedQuery) ||
          (l.version_hint &&
            l.version_hint.toLowerCase().includes(combinedQuery))
      )
    );
  });

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Header Banner */}
      <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <h1 className="text-base font-bold text-slate-100">
              ⚡ Binary Shadowing Inspector
            </h1>
          </div>
          <p className="text-xs text-slate-400">
            Compares which binary version actually executes (🥇 Active) and which versions are hidden (🥈 Shadowed) when identical command names exist across multiple PATH directories.
          </p>
        </div>

        <button
          onClick={() => refreshDiagnostics(true)}
          disabled={isLoading}
          className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${isLoading ? "animate-spin text-emerald-400" : ""}`}
          />
          <span>Re-probe Versions (--version)</span>
        </button>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            placeholder="Filter binary name (e.g., python, node, java, git, curl)..."
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyDevTools}
              onChange={(e) => setOnlyDevTools(e.target.checked)}
              className="rounded border-slate-700 bg-slate-900 text-emerald-500"
            />
            <span>Show major developer tools only (python, node, java, git, etc.)</span>
          </label>
          <span className="text-xs font-mono text-slate-400">
            Showing: {filteredConflicts.length} / {conflicts.length}
          </span>
        </div>
      </div>

      {/* Conflict Groups List */}
      {filteredConflicts.length === 0 ? (
        <div className="p-10 rounded-2xl bg-slate-900/50 border border-slate-800 text-center space-y-2">
          <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
          <div className="text-sm font-bold text-slate-200">
            {conflicts.length > 0
              ? "No conflicts match the current filter."
              : "No binary shadowing conflicts found."}
          </div>
          <p className="text-xs text-slate-400">
            {conflicts.length > 0
              ? `${conflicts.length} conflict(s) exist; clear the search box or the developer-tools filter to see them.`
              : "All commands resolve to a unique PATH location."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredConflicts.map((conflict) => {
            const activeLoc =
              conflict.locations.find((loc) => loc.is_active) ??
              conflict.locations[0];
            return (
              <div
                key={conflict.binary_name}
                className="rounded-xl bg-slate-900/80 border border-slate-800 overflow-hidden"
              >
                {/* Group Header */}
                <div className="px-4 py-2.5 bg-slate-950/70 border-b border-slate-800/80 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-amber-400" />
                    <span className="font-mono text-sm font-bold text-slate-100">
                      {conflict.binary_name}
                    </span>
                    {DEV_TOOL_NAMES.has(conflict.binary_name.toLowerCase()) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        Dev Tool
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400">
                    Found in {conflict.locations.length} PATH locations
                  </span>
                </div>

                {/* Instances */}
                <div className="p-3 space-y-2">
                  {conflict.locations.map((loc, idx) => {
                    const entry = pathEntries[loc.path_entry_index];
                    const scopeInfo = entry
                      ? formatScopeInfo(entry.scope)
                      : null;

                    return (
                      <div
                        key={`${loc.full_path}-${idx}`}
                        onClick={() => entry && selectPathEntry(entry.id)}
                        className={`p-3 rounded-lg border flex flex-wrap items-center justify-between gap-3 cursor-pointer transition ${
                          loc.is_active
                            ? "bg-emerald-500/10 border-emerald-500/30"
                            : "bg-slate-950/70 hover:bg-slate-950 border-slate-800"
                        }`}
                      >
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {loc.is_active ? (
                              <span className="text-xs font-bold text-emerald-300">
                                🥇 [Active]
                              </span>
                            ) : (
                              <span className="text-xs font-bold text-amber-300">
                                🥈 [Shadowed]
                              </span>
                            )}

                            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                              PATH #{loc.path_entry_index + 1}
                            </span>

                            {scopeInfo && (
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-700">
                                [{scopeInfo.badge}]
                              </span>
                            )}

                            {loc.version_hint && (
                              <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-slate-900 text-emerald-300 border border-emerald-500/30">
                                ({loc.version_hint})
                              </span>
                            )}
                          </div>

                          <div className="font-mono text-xs text-slate-200 break-all">
                            {loc.full_path}
                          </div>
                        </div>

                        {!loc.is_active && activeLoc && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              promoteBinaryInstance(
                                loc.path_entry_index,
                                activeLoc.path_entry_index
                              );
                            }}
                            className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shrink-0 transition shadow-sm"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                            <span>Promote to Activate</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
