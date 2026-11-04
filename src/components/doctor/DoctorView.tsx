import React from "react";
import {
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Download,
  Sparkles,
  Zap,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import { ActionMenu } from "../common/ActionMenu";
import { DiagnosticIssueCard } from "../common/DiagnosticIssueCard";
import { REPORT_FORMATS } from "../../utils/reportExport";
import {
  formatScopeInfo,
  isAliasIssue,
  isCriticalSystemPath,
  isSessionScope,
  isUnscoredIssue,
  type DiagnosticIssue,
  type PathEntry,
} from "../../types/ipc";

export const DoctorView: React.FC = () => {
  const {
    score,
    deadCount,
    duplicateCount,
    aliasCount,
    emptyCount,
    unexpandedCount,
    securityCount,
    orderCount,
    sessionCount,
    conflictCount,
    pathEntries,
    conflicts,
    globalSearch,
    cleanAllPaths,
    exportDiagnosticReport,
    promoteBinaryInstance,
    selectPathEntry,
    setActiveTab,
  } = useEnvStore();

  const cleanableCount = deadCount + duplicateCount + unexpandedCount;

  // Split findings into real problems, optional hardening tips, informational
  // notes (symlink aliases) and session entries, so a "no action needed" item is
  // never listed as a problem and a tip never looks like a fault.
  const searchMatches = (entry: (typeof pathEntries)[number]) => {
    if (!globalSearch.trim()) return true;
    const q = globalSearch.toLowerCase();
    return (
      entry.raw_value.toLowerCase().includes(q) ||
      entry.resolved_value.toLowerCase().includes(q)
    );
  };

  const isOrderRisk = (issue: (typeof pathEntries)[number]["issues"][number]) =>
    typeof issue === "object" && issue !== null && "OrderRisk" in issue;

  const indexed = pathEntries.map((entry, index) => ({ entry, index }));

  const problems = indexed.filter(
    ({ entry }) =>
      entry.issues.some((i) => !isUnscoredIssue(i)) && searchMatches(entry)
  );
  // The verdict and the "nothing to fix" state describe the machine, not the
  // search box: filtering every problem out must not claim the PATH is healthy
  // while the summary badges above still count the findings.
  const allProblems = indexed.filter(({ entry }) =>
    entry.issues.some((i) => !isUnscoredIssue(i))
  );

  // Tips and notes are *entry* lists, not "entries without other problems":
  // an entry can be both a scored problem and a hardening tip, and each section
  // shows only the issues it is about. This keeps the badges (which count issues)
  // and the section headers (which count entries) in agreement.
  const tips = indexed.filter(
    ({ entry }) => entry.issues.some(isOrderRisk) && searchMatches(entry)
  );

  const notes = indexed.filter(
    ({ entry }) => entry.issues.some(isAliasIssue) && searchMatches(entry)
  );

  // Session entries are listed so the effective PATH is complete, but nothing in
  // them is actionable: no config file declares them and they are never scored.
  const sessionEntries = indexed.filter(
    ({ entry }) => isSessionScope(entry.scope) && searchMatches(entry)
  );

  const renderEntryCard = (
    { entry, index }: { entry: PathEntry; index: number },
    issueFilter?: (issue: DiagnosticIssue) => boolean
  ) => {
    const scopeInfo = formatScopeInfo(entry.scope);
    const isProtected = isCriticalSystemPath(
      entry.raw_value,
      entry.resolved_value
    );
    const visibleIssues = issueFilter
      ? entry.issues.filter(issueFilter)
      : entry.issues.filter((issue) => !isUnscoredIssue(issue));

    return (
      <div
        key={entry.id}
        onClick={() => selectPathEntry(entry.id)}
        className="p-3.5 rounded-xl bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 transition cursor-pointer space-y-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono text-slate-500 w-6">
              #{index + 1}
            </span>
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                scopeInfo.kind === "system"
                  ? "bg-indigo-500/15 text-indigo-300 border-indigo-500/30"
                  : scopeInfo.kind === "user"
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-amber-500/15 text-amber-300 border-amber-500/30"
              }`}
            >
              {scopeInfo.badge}
            </span>
            <span className="font-mono text-xs text-slate-100 truncate">
              {entry.raw_value}
            </span>
          </div>
          <span className="text-[11px] text-slate-400 shrink-0">
            {entry.executable_count} executables
          </span>
        </div>

        {/* Per-issue guidance + one-click fix */}
        <div className="pl-8 space-y-1.5">
          {visibleIssues.map((issue, i) => (
            <DiagnosticIssueCard
              key={i}
              issue={issue}
              entry={entry}
              allEntries={pathEntries}
              isProtected={isProtected}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
      {/* Top Health Score Hero Card */}
      <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/30 border border-slate-800 p-5 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                Doctor Engine Diagnostic Report
              </span>
              <span className="text-xs text-slate-400">
                {pathEntries.length} PATH entries scanned
              </span>
            </div>
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-extrabold text-slate-100">
                📊 PATH Health Score:
              </h1>
              <span
                className={`text-3xl font-black font-mono ${
                  score >= 85
                    ? "text-emerald-400"
                    : score >= 65
                      ? "text-amber-400"
                      : "text-rose-400"
                }`}
              >
                {score} / 100
              </span>
            </div>

            {/* Plain-language verdict so the numbers above are actionable */}
            <p className="text-xs text-slate-400 max-w-2xl">
              {allProblems.length === 0
                ? "No PATH entry from your configuration needs fixing."
                : `${allProblems.length} of ${pathEntries.length} PATH entries have a problem.${
                    problems.length < allProblems.length
                      ? ` The search hides ${allProblems.length - problems.length} of them.`
                      : " The list below explains each one and offers a fix."
                  }`}
              {sessionCount > 0 &&
                ` ${sessionCount} PATH ${
                  sessionCount === 1 ? "entry comes" : "entries come"
                } from this session rather than a config file, so ${
                  sessionCount === 1 ? "it is" : "they are"
                } listed separately and left out of the score.`}
            </p>

            {/* Summary Badges (Wireframe Section 6) */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-rose-500/15 text-rose-300 border border-rose-500/30 font-medium">
                🔴 Missing folders: {deadCount}
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium">
                🟡 Duplicates: {duplicateCount}
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-200 border border-amber-500/20 font-medium">
                🟡 Empty folders: {emptyCount}
              </span>
              {aliasCount > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-slate-500/15 text-slate-300 border border-slate-500/30 font-medium"
                  title="Symlink aliases of directories already in PATH (e.g. /bin -> /usr/bin). Informational only — not scored and not auto-merged."
                >
                  ⚪ Aliases: {aliasCount}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/30 font-medium">
                🔵 Hard-coded home paths: {unexpandedCount}
              </span>
              {securityCount > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-rose-500/20 text-rose-200 border border-rose-500/40 font-semibold"
                  title="Folders every account on the machine can write to. Anyone could place a program here that runs instead of the real command."
                >
                  🔴 World-writable folders: {securityCount}
                </span>
              )}
              {orderCount > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-slate-500/15 text-slate-300 border border-slate-500/30 font-medium"
                  title="A folder you can write to is searched before the system folders. This is the normal setup for rustup/nvm, so it costs no score."
                >
                  ⚪ Order tips: {orderCount}
                </span>
              )}
              {sessionCount > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-slate-500/10 text-slate-400 border border-slate-600/40 font-medium"
                  title="Added by this session (a tool manager or package manager), not by any config file. Never scored and never flagged."
                >
                  ⚙️ Session entries: {sessionCount}
                </span>
              )}
              <button
                onClick={() => setActiveTab("shadowing")}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 border border-violet-500/30 font-medium transition"
              >
                ⚡ Binary Conflicts: {conflictCount}
              </button>
            </div>
          </div>

          {/* One-Click Clean All CTA */}
          <div className="flex flex-col sm:flex-row lg:flex-col items-stretch sm:items-center lg:items-end gap-2 shrink-0">
            <ActionMenu
              label="Export report"
              icon={<Download className="w-4 h-4" />}
              placement="down"
              className="shrink-0"
              buttonClassName="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold text-xs flex items-center justify-center gap-2 transition"
              actions={REPORT_FORMATS.map((format) => ({
                id: format.id,
                label: format.label,
                description: format.description,
                onSelect: () => exportDiagnosticReport(format.id),
              }))}
            />
            <button
              onClick={() => cleanAllPaths()}
              disabled={cleanableCount === 0}
              className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition"
            >
              <Sparkles className="w-4 h-4" />
              <span>✨ One-Click Clean All</span>
            </button>
            <span className="text-[11px] text-slate-400">
              Stages removal of dead paths, merges duplicates, and shortens home variables
            </span>
          </div>
        </div>
      </div>

      {/* Diagnostic Issues List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <span>
              🩺 PATH problems ({problems.length}
              {problems.length !== allProblems.length
                ? ` of ${allProblems.length}`
                : ""}
              )
            </span>
          </h2>
          <button
            onClick={() => setActiveTab("path-editor")}
            className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium"
          >
            <span>Open Drag &amp; Drop PATH Editor</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {problems.length === 0 ? (
          allProblems.length === 0 ? (
            <div className="p-8 rounded-2xl bg-slate-900/60 border border-slate-800 text-center space-y-2">
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
              <div className="text-sm font-bold text-slate-200">
                Nothing to fix
              </div>
              <p className="text-xs text-slate-400">
                No missing folders, empty folders, duplicate entries,
                world-writable folders or hard-coded home paths were found.
                {tips.length > 0 && " The tips below are optional."}
                {notes.length > 0 && " The notes below need no action."}
              </p>
            </div>
          ) : (
            <div className="p-8 rounded-2xl bg-slate-900/60 border border-slate-800 text-center space-y-2">
              <div className="text-sm font-bold text-slate-200">
                No problems match the search
              </div>
              <p className="text-xs text-slate-400">
                {allProblems.length} PATH{" "}
                {allProblems.length === 1 ? "entry still has" : "entries still have"}{" "}
                a problem; clear the search box to see{" "}
                {allProblems.length === 1 ? "it" : "them"}.
              </p>
            </div>
          )
        ) : (
          <div className="space-y-2.5">
            {problems.map((item) => renderEntryCard(item))}
          </div>
        )}

        {tips.length > 0 && (
          <div className="space-y-2.5 pt-1">
            <h2 className="text-sm font-bold text-slate-300">
              💡 Optional hardening tips ({tips.length})
            </h2>
            <p className="text-[11px] text-slate-500">
              A folder you can write to is searched before the system folders.
              This is exactly what rustup, nvm and pyenv do when you install
              them, so nothing here affects the health score — reorder only if
              you run code you do not trust on this machine.
            </p>
            <div className="space-y-2.5">
              {tips.map((item) => renderEntryCard(item, isOrderRisk))}
            </div>
          </div>
        )}

        {notes.length > 0 && (
          <div className="space-y-2.5 pt-1">
            <h2 className="text-sm font-bold text-slate-300">
              📝 Notes — nothing to fix ({notes.length})
            </h2>
            <p className="text-[11px] text-slate-500">
              These entries use two different names for a folder that is already
              in PATH. That is normal on most Linux systems, so they are left
              untouched.
            </p>
            <div className="space-y-2.5">
              {notes.map((item) => renderEntryCard(item, isAliasIssue))}
            </div>
          </div>
        )}

        {sessionEntries.length > 0 && (
          <div className="space-y-2.5 pt-1">
            <h2 className="text-sm font-bold text-slate-300">
              ⚙️ Session PATH entries ({sessionEntries.length})
            </h2>
            <p className="text-[11px] text-slate-500">
              Added by the process that started this app — a tool manager or
              package manager prepended them; no config file declares them. They
              are never flagged and never scored, but they are shown so the
              effective PATH is complete. A folder listed here that no longer
              exists is dropped when you apply changes.
            </p>
            <div className="space-y-1.5">
              {sessionEntries.map(({ entry, index }) => (
                <button
                  key={entry.id}
                  onClick={() => selectPathEntry(entry.id)}
                  className="w-full text-left p-2.5 rounded-lg bg-slate-900/50 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 transition flex items-center gap-3"
                >
                  <span className="text-xs font-mono text-slate-500 w-6 shrink-0">
                    #{index + 1}
                  </span>
                  <span className="font-mono text-xs text-slate-300 truncate flex-1">
                    {entry.raw_value}
                  </span>
                  <span className="text-[11px] text-slate-500 shrink-0">
                    {entry.exists
                      ? `${entry.executable_count} executables`
                      : "does not exist"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Quick Binary Shadowing Preview */}
      {conflicts.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span>Top Binary Shadowing Conflicts</span>
            </h2>
            <button
              onClick={() => setActiveTab("shadowing")}
              className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 font-medium"
            >
              <span>Inspect all {conflicts.length} conflicts</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {conflicts.slice(0, 4).map((conflict) => {
              const active = conflict.locations[0];
              const shadowed = conflict.locations[1];
              return (
                <div
                  key={conflict.binary_name}
                  className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      {conflict.binary_name}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Found in {conflict.locations.length} PATH locations
                    </span>
                  </div>

                  {active && (
                    <div className="text-xs flex items-center justify-between gap-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                      <div className="min-w-0">
                        <span className="font-semibold text-emerald-300 mr-1.5">
                          🥇 [Active #{active.path_entry_index + 1}]
                        </span>
                        <span className="font-mono text-slate-200 break-all">
                          {active.full_path}
                        </span>
                      </div>
                      {active.version_hint && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-950 text-emerald-300 shrink-0">
                          {active.version_hint}
                        </span>
                      )}
                    </div>
                  )}

                  {shadowed && (
                    <div className="text-xs flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-950/80 border border-slate-800">
                      <div className="min-w-0">
                        <span className="font-semibold text-amber-300 mr-1.5">
                          🥈 [Shadowed #{shadowed.path_entry_index + 1}]
                        </span>
                        <span className="font-mono text-slate-400 break-all">
                          {shadowed.full_path}
                        </span>
                        {shadowed.version_hint && (
                          <span className="ml-1.5 text-[10px] font-mono text-amber-300">
                            ({shadowed.version_hint})
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() =>
                          promoteBinaryInstance(
                            shadowed.path_entry_index,
                            active.path_entry_index
                          )
                        }
                        className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-[11px] font-medium flex items-center gap-1 shrink-0 transition"
                      >
                        <ArrowUp className="w-3 h-3" /> Promote
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
