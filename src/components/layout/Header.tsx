import React, { useEffect, useRef } from "react";
import {
  CheckCircle2,
  Redo2,
  RefreshCw,
  RotateCcw,
  Search,
  Stethoscope,
  Undo2,
  X,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";

export const Header: React.FC = () => {
  const {
    globalSearch,
    setGlobalSearch,
    isLoading,
    refreshDiagnostics,
    historyPast,
    historyFuture,
    undo,
    redo,
    stagedChangeCount,
    discardStagedChanges,
    openApplyModal,
  } = useEnvStore();

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A dialog covers the page, but these shortcuts still target the state
      // behind it: undo/redo would change the staged list after the Apply modal
      // captured it, so the reviewed diff would no longer match what is written.
      const store = useEnvStore.getState();
      if (store.isApplyModalOpen || store.safeGuardWarning) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "z" &&
        !e.shiftKey
      ) {
        if (
          document.activeElement?.tagName !== "INPUT" &&
          document.activeElement?.tagName !== "TEXTAREA"
        ) {
          e.preventDefault();
          undo();
        }
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.key.toLowerCase() === "y" ||
          (e.shiftKey && e.key.toLowerCase() === "z"))
      ) {
        if (
          document.activeElement?.tagName !== "INPUT" &&
          document.activeElement?.tagName !== "TEXTAREA"
        ) {
          e.preventDefault();
          redo();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  return (
    <header className="h-14 border-b border-slate-800/80 bg-slate-900/90 backdrop-blur-md px-4 flex items-center justify-between gap-4 shrink-0 select-none">
      {/* Brand Title */}
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-inner">
          <Stethoscope className="w-4 h-4" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm tracking-tight text-slate-100">
              🩺 Env &amp; PATH Doctor
            </span>
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              v1.0.0
            </span>
          </div>
          <p className="text-[11px] text-slate-400 hidden sm:block">
            Cross-Platform Environment Diagnostics, Shadowing Inspector &amp; Time Machine
          </p>
        </div>
      </div>

      {/* Global Search (Ctrl+K) */}
      <div className="flex-1 max-w-md relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={searchInputRef}
          type="text"
          value={globalSearch}
          onChange={(e) => setGlobalSearch(e.target.value)}
          placeholder="Search paths, binaries (python, node), or variables... (Ctrl+K)"
          className="w-full bg-slate-950/80 border border-slate-800 focus:border-emerald-500/60 rounded-lg pl-9 pr-14 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors"
        />
        {globalSearch ? (
          <button
            onClick={() => setGlobalSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
            title="Clear search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
            Ctrl+K
          </kbd>
        )}
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => undo()}
          disabled={historyPast.length === 0}
          title="Undo (Ctrl+Z)"
          className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 disabled:opacity-35 disabled:pointer-events-none transition"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          onClick={() => redo()}
          disabled={historyFuture.length === 0}
          title="Redo (Ctrl+Y)"
          className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 disabled:opacity-35 disabled:pointer-events-none transition"
        >
          <Redo2 className="w-4 h-4" />
        </button>

        <button
          onClick={() => refreshDiagnostics(true)}
          disabled={isLoading}
          title="Rescan system environment"
          className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 disabled:opacity-50 transition"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin text-emerald-400" : ""}`} />
        </button>

        {stagedChangeCount > 0 && (
          <button
            onClick={() => discardStagedChanges()}
            title="Discard staged changes"
            className="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-xs text-slate-300 flex items-center gap-1 transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
        )}

        <button
          onClick={() => openApplyModal()}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow-sm ${
            stagedChangeCount > 0
              ? "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20"
              : "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Apply ({stagedChangeCount})</span>
        </button>
      </div>
    </header>
  );
};
