import React, { useEffect, useState } from "react";
import {
  ArrowUp,
  CheckCircle2,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Info,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import { DiagnosticIssueCard } from "../common/DiagnosticIssueCard";
import { formatScopeInfo, isCriticalSystemPath } from "../../types/ipc";

export const RightInspector: React.FC = () => {
  const {
    pathEntries,
    selectedPathId,
    selectedDirExecutables,
    isLoadingDirExes,
    conflicts,
    promoteBinaryInstance,
  } = useEnvStore();

  const [exeFilter, setExeFilter] = useState("");

  const selectedIndex = pathEntries.findIndex((p) => p.id === selectedPathId);
  const entry = selectedIndex >= 0 ? pathEntries[selectedIndex] : null;

  // The filter input is only rendered for a folder with more than five
  // executables, so carrying its text to another selection — or to another
  // directory of the same row after an edit — would hide that folder's entries
  // behind an invisible filter.
  useEffect(() => {
    setExeFilter("");
  }, [selectedPathId, entry?.raw_value]);

  if (!entry) {
    return (
      <aside className="w-80 border-l border-slate-800/80 bg-slate-900/50 p-4 flex flex-col items-center justify-center text-center shrink-0">
        <FolderOpen className="w-8 h-8 text-slate-600 mb-2" />
        <p className="text-xs font-medium text-slate-400">
          Select a PATH entry from the center list to inspect its origin, diagnostic issues, and contained executables.
        </p>
      </aside>
    );
  }

  const scopeInfo = formatScopeInfo(entry.scope);
  const isProtected = isCriticalSystemPath(
    entry.raw_value,
    entry.resolved_value
  );

  // Find any binary conflicts where this path entry has a shadowed binary
  const shadowedInThisEntry = conflicts.flatMap((c) => {
    const loc = c.locations.find(
      (l) => l.path_entry_index === selectedIndex && !l.is_active
    );
    const activeLoc = c.locations.find((l) => l.is_active);
    if (loc && activeLoc) {
      return [
        {
          binaryName: c.binary_name,
          instance: loc,
          activeInstance: activeLoc,
        },
      ];
    }
    return [];
  });

  const filteredExes = selectedDirExecutables.filter((exe) =>
    exe.name.toLowerCase().includes(exeFilter.toLowerCase())
  );

  return (
    <aside className="w-80 border-l border-slate-800/80 bg-slate-900/60 flex flex-col shrink-0 overflow-hidden">
      {/* Header */}
      <div className="p-3.5 border-b border-slate-800/80 flex items-center justify-between">
        <span className="text-xs font-bold text-slate-200 tracking-tight">
          [Inspector]
        </span>
        <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
          Priority #{selectedIndex + 1}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
        {/* Selected Path Info */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-400">
            Selected (Raw Path):
          </div>
          <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-100 break-all">
            {entry.raw_value}
          </div>
          {entry.raw_value !== entry.resolved_value && (
            <div className="text-[11px] text-slate-400 break-all">
              <span className="text-slate-500">Resolved Path: </span>
              <span className="font-mono text-emerald-300">
                {entry.resolved_value}
              </span>
            </div>
          )}
          {isProtected && (
            <div className="flex items-center gap-1.5 text-[11px] text-sky-400 bg-sky-500/10 border border-sky-500/20 rounded-md px-2 py-1">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>Protected OS System Path (Safe Guard Active)</span>
            </div>
          )}
        </div>

        {/* Source / Dotfile Deep Link */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-400">
            Source:
          </div>
          <div className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-slate-200 font-mono break-all">
              <FileCode2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>{scopeInfo.sourceText}</span>
            </div>
            {scopeInfo.vscodeUrl && (
              <a
                href={scopeInfo.vscodeUrl}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/30 transition"
              >
                <ExternalLink className="w-3 h-3" />
                <span>Open Exact Line in VS Code</span>
              </a>
            )}
          </div>
        </div>

        {/* Detected Issues & Shadowing Alerts */}
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-slate-400">
            ⚠️ Detected Issues ({entry.issues.length + shadowedInThisEntry.length}):
          </div>

          {entry.issues.length === 0 && shadowedInThisEntry.length === 0 ? (
            <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center gap-2 text-xs text-emerald-300">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>No path errors or shadowed binaries detected.</span>
            </div>
          ) : (
            <div className="space-y-2">
              {entry.issues.map((issue, idx) => (
                <DiagnosticIssueCard
                  key={idx}
                  issue={issue}
                  entry={entry}
                  allEntries={pathEntries}
                  layout="stacked"
                  isProtected={isProtected}
                />
              ))}

              {shadowedInThisEntry.map((sh) => (
                <div
                  key={sh.binaryName}
                  className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-2"
                >
                  <div className="text-xs text-amber-200">
                    <span className="font-mono font-bold text-amber-300">
                      {sh.binaryName}
                    </span>
                    {sh.instance.version_hint
                      ? ` (${sh.instance.version_hint})`
                      : ""}{" "}
                    is shadowed by{" "}
                    <span className="font-bold">
                      entry #{sh.activeInstance.path_entry_index + 1}
                    </span>
                    .
                  </div>
                  <button
                    onClick={() =>
                      promoteBinaryInstance(
                        selectedIndex,
                        sh.activeInstance.path_entry_index
                      )
                    }
                    className="w-full py-1 px-2 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 text-[11px] font-medium flex items-center justify-center gap-1 transition"
                  >
                    <ArrowUp className="w-3 h-3" /> Promote to Activate
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Contained Executables List (Wireframe Section 6) */}
        <div className="space-y-2 pt-2 border-t border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400">
              Contained Executables ({entry.executable_count}):
            </span>
          </div>

          {entry.executable_count > 5 && (
            <input
              type="text"
              value={exeFilter}
              onChange={(e) => setExeFilter(e.target.value)}
              placeholder="Filter executables in folder..."
              className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50"
            />
          )}

          {isLoadingDirExes ? (
            <div className="text-xs text-slate-500 py-4 text-center">
              Loading executables...
            </div>
          ) : !entry.exists ? (
            <div className="text-xs text-slate-500 py-2">
              Directory does not exist on disk.
            </div>
          ) : filteredExes.length === 0 ? (
            <div className="text-xs text-slate-500 py-2">
              No matching executables found.
            </div>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
              {filteredExes.slice(0, 120).map((exe) => (
                <div
                  key={exe.full_path}
                  className="px-2 py-1.5 rounded bg-slate-950/70 border border-slate-800/80 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Terminal className="w-3 h-3 text-slate-400 shrink-0" />
                    <span className="font-mono text-slate-200 truncate">
                      {exe.name}
                    </span>
                    {exe.version_hint && (
                      <span className="text-[10px] font-mono text-emerald-400 truncate">
                        ({exe.version_hint})
                      </span>
                    )}
                  </div>
                  {exe.is_shadowed && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0"
                      title={`Active path: ${exe.active_path}`}
                    >
                      Shadowed
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
