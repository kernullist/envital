import React, { useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUp,
  Check,
  Edit3,
  FolderPlus,
  GripVertical,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEnvStore } from "../../store/useEnvStore";
import { DiagnosticIssueCard } from "../common/DiagnosticIssueCard";
import { Select } from "../common/Select";
import {
  formatScopeInfo,
  isCriticalSystemPath,
  isUnscoredIssue,
  isWindowsPlatform,
  type PathEntry,
  type Scope,
  type ScopeFilter,
} from "../../types/ipc";

interface SortablePathRowProps {
  entry: PathEntry;
  index: number;
  isSelected: boolean;
  /** Full PATH list, so issue messages can name the real path behind "position #N". */
  allEntries: PathEntry[];
  shadowedBinaries: {
    binaryName: string;
    activeEntryIndex: number;
    versionHint: string | null;
  }[];
  onSelect: () => void;
  onRemove: () => void;
  onPromote: (activeIndex: number) => void;
  onUpdateValue: (newValue: string) => void;
}

const SortablePathRow: React.FC<SortablePathRowProps> = ({
  entry,
  index,
  isSelected,
  allEntries,
  shadowedBinaries,
  onSelect,
  onRemove,
  onPromote,
  onUpdateValue,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id });

  const [isEditing, setIsEditing] = useState(false);
  const [editVal, setEditVal] = useState(entry.raw_value);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const scopeInfo = formatScopeInfo(entry.scope);
  const isProtected = isCriticalSystemPath(
    entry.raw_value,
    entry.resolved_value
  );

  const hasDead = entry.issues.includes("DeadPath");
  const hasSecurity = entry.issues.some(
    (i) => typeof i === "object" && "SecurityRisk" in i
  );

  // Informational notes (symlink aliases) and hardening tips (a user folder
  // ahead of the system ones) must not turn an otherwise healthy entry yellow:
  // they cost no score and the Doctor view files them under tips/notes.
  const hasActionableIssue = entry.issues.some((i) => !isUnscoredIssue(i));

  const statusDot =
    hasDead || hasSecurity
      ? "🔴"
      : hasActionableIssue || shadowedBinaries.length > 0
        ? "🟡"
        : "🟢";

  const handleSaveEdit = () => {
    if (editVal.trim() && editVal.trim() !== entry.raw_value) {
      onUpdateValue(editVal.trim());
    }
    setIsEditing(false);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={`rounded-xl border transition-all select-none ${
        isDragging
          ? "z-30 bg-slate-800 border-emerald-500 shadow-2xl opacity-95"
          : isSelected
            ? "bg-slate-900 border-emerald-500/60 shadow-md"
            : "bg-slate-900/70 hover:bg-slate-900 border-slate-800/90"
      }`}
    >
      {/* Main Row */}
      <div className="px-3 py-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Drag Handle */}
          <button
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-slate-300 cursor-grab active:cursor-grabbing shrink-0"
            title="Drag to reorder PATH priority"
          >
            <GripVertical className="w-4 h-4" />
          </button>

          {/* Priority Number */}
          <span className="text-xs font-mono text-slate-400 w-6 text-right shrink-0">
            {index + 1}.
          </span>

          {/* Scope Tag */}
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
              scopeInfo.kind === "system"
                ? "bg-indigo-500/15 text-indigo-300 border-indigo-500/30"
                : scopeInfo.kind === "user"
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  : "bg-amber-500/15 text-amber-300 border-amber-500/30"
            }`}
          >
            [{scopeInfo.badge}]
          </span>

          {/* Path Value or Inline Input */}
          {isEditing ? (
            <div
              className="flex items-center gap-1.5 flex-1"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                value={editVal}
                onChange={(e) => setEditVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveEdit();
                  if (e.key === "Escape") setIsEditing(false);
                }}
                autoFocus
                className="flex-1 bg-slate-950 border border-emerald-500/60 rounded px-2 py-1 text-xs font-mono text-slate-100 focus:outline-none"
              />
              <button
                onClick={handleSaveEdit}
                className="p-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="p-1 rounded bg-slate-800 text-slate-400 hover:text-slate-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <span
              className={`font-mono text-xs truncate ${
                hasDead
                  ? "text-rose-300 line-through decoration-rose-500/60"
                  : "text-slate-100"
              }`}
              title={entry.raw_value}
            >
              {entry.raw_value}
            </span>
          )}
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {isProtected && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 flex items-center gap-1"
              title="Protected OS system path"
            >
              <ShieldCheck className="w-3 h-3" /> Protected
            </span>
          )}
          <span className="text-xs" title="Diagnostic status">
            {statusDot}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditVal(entry.raw_value);
              setIsEditing(true);
            }}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
            title="Edit path value"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className={`p-1 rounded transition ${
              isProtected
                ? "text-slate-600 hover:text-rose-400"
                : "hover:bg-rose-500/20 text-slate-400 hover:text-rose-300"
            }`}
            title={
              isProtected
                ? "Critical system path protected by Safe Guard"
                : "Delete path entry"
            }
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Inline Sub-rows for Issues & Shadowing */}
      {(entry.issues.length > 0 || shadowedBinaries.length > 0) && (
        <div className="px-10 pb-2.5 space-y-1">
          {entry.issues.map((issue, i) => (
            <DiagnosticIssueCard
              key={i}
              issue={issue}
              entry={entry}
              allEntries={allEntries}
              dense
              isProtected={isProtected}
            />
          ))}

          {shadowedBinaries.slice(0, 2).map((sh) => (
            <div
              key={sh.binaryName}
              className="flex items-center justify-between text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-md px-2.5 py-1"
            >
              <span>
                └─ [Warn] <code className="font-bold">{sh.binaryName}</code>
                {sh.versionHint ? ` (${sh.versionHint})` : ""} shadowed by entry #
                {sh.activeEntryIndex + 1}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onPromote(sh.activeEntryIndex);
                }}
                className="px-2 py-0.5 rounded bg-amber-500/25 hover:bg-amber-500/35 text-amber-100 font-semibold flex items-center gap-1 transition"
              >
                <ArrowUp className="w-3 h-3" /> [Promote]
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const PathEditorView: React.FC = () => {
  const {
    pathEntries,
    conflicts,
    score,
    deadCount,
    duplicateCount,
    aliasCount,
    conflictCount,
    scopeFilter,
    setScopeFilter,
    globalSearch,
    selectedPathId,
    selectPathEntry,
    reorderPathEntries,
    removePathEntry,
    promoteBinaryInstance,
    cleanAllPaths,
    addNewPathEntry,
    updatePathEntryValue,
  } = useEnvStore();

  const [newPathInput, setNewPathInput] = useState("");
  const [newPathScope, setNewPathScope] = useState<Scope>("User");
  const windows = isWindowsPlatform();
  // On Linux there is no per-user / machine-wide split: Apply writes every
  // non-session entry to ~/.config/env-doctor/env.sh for this account only. A
  // "System" option would promise something the platform cannot do.
  const addScope: Scope = windows ? newPathScope : "User";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderPathEntries(String(active.id), String(over.id));
    }
  };

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Directory to Add to PATH",
      });
      if (typeof selected === "string" && selected.trim()) {
        await addNewPathEntry(selected, addScope);
      }
    } catch {
      // Fallback if not inside native Tauri window
    }
  };

  const handleAddManualPath = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPathInput.trim()) return;
    await addNewPathEntry(newPathInput, addScope);
    setNewPathInput("");
  };

  const filteredEntries = pathEntries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .filter(({ entry }) => {
      const info = formatScopeInfo(entry.scope);
      if (scopeFilter === "user" && info.kind !== "user") return false;
      if (scopeFilter === "system" && info.kind !== "system") return false;
      if (scopeFilter === "dotfile" && info.kind !== "dotfile") return false;
      if (scopeFilter === "session" && info.kind !== "process") return false;
      if (globalSearch.trim()) {
        const q = globalSearch.toLowerCase();
        return (
          entry.raw_value.toLowerCase().includes(q) ||
          entry.resolved_value.toLowerCase().includes(q)
        );
      }
      return true;
    });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top Diagnostic Summary & Filter Bar */}
      <div className="p-4 border-b border-slate-800/80 bg-slate-900/40 space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-extrabold text-slate-100 mr-1">
              📊 PATH Health Score: {score} / 100
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30">
              🔴 Dead: {deadCount}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
              🟡 Duplicate: {duplicateCount}
            </span>
            {aliasCount > 0 && (
              <span
                className="text-xs px-2 py-0.5 rounded bg-slate-500/15 text-slate-300 border border-slate-500/30"
                title="Symlink aliases of directories already in PATH (e.g. /bin -> /usr/bin). Informational — never merged automatically."
              >
                ⚪ Aliases: {aliasCount}
              </span>
            )}
            <span className="text-xs px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">
              ⚡ Conflicts: {conflictCount}
            </span>
          </div>

          <button
            onClick={() => cleanAllPaths()}
            className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center gap-1.5 transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>✨ One-Click Clean All</span>
          </button>
        </div>

        {/* Scope Filter Pills */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            {(
              [
                { id: "all", label: "All" },
                { id: "user", label: "User (USR)" },
                { id: "system", label: "System (SYS)" },
                { id: "dotfile", label: "Dotfiles" },
                { id: "session", label: "Session (PROC)" },
              ] as { id: ScopeFilter; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setScopeFilter(tab.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                  scopeFilter === tab.id
                    ? "bg-emerald-500 text-slate-950 font-bold"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-400">
            Drag the handle (≡) up or down to reorder PATH priority
          </span>
        </div>
      </div>

      {/* Sortable PATH List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={filteredEntries.map((item) => item.entry.id)}
            strategy={verticalListSortingStrategy}
          >
            {filteredEntries.map(({ entry, originalIndex }) => {
              // Check if any binary in this entry is shadowed
              const shadowedBinaries = conflicts.flatMap((c) => {
                const loc = c.locations.find(
                  (l) => l.path_entry_index === originalIndex && !l.is_active
                );
                const activeLoc = c.locations.find((l) => l.is_active);
                if (loc && activeLoc) {
                  return [
                    {
                      binaryName: c.binary_name,
                      activeEntryIndex: activeLoc.path_entry_index,
                      versionHint: loc.version_hint,
                    },
                  ];
                }
                return [];
              });

              return (
                <SortablePathRow
                  key={entry.id}
                  entry={entry}
                  index={originalIndex}
                  isSelected={selectedPathId === entry.id}
                  allEntries={pathEntries}
                  shadowedBinaries={shadowedBinaries}
                  onSelect={() => selectPathEntry(entry.id)}
                  onRemove={() => removePathEntry(entry.id)}
                  onPromote={(activeIdx) =>
                    promoteBinaryInstance(originalIndex, activeIdx)
                  }
                  onUpdateValue={(newVal) =>
                    updatePathEntryValue(entry.id, newVal)
                  }
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      {/* Bottom Add New Path Bar */}
      <form
        onSubmit={handleAddManualPath}
        className="p-3.5 border-t border-slate-800/80 bg-slate-900/80 flex flex-wrap items-center gap-2 shrink-0"
      >
        {windows ? (
          <Select
            value={newPathScope === "System" ? "System" : "User"}
            onChange={(next) => setNewPathScope(next)}
            ariaLabel="Which PATH should the new entry be added to"
            placement="up"
            className="shrink-0"
            options={[
              { value: "User", label: "[USR] User PATH" },
              { value: "System", label: "[SYS] System PATH" },
            ]}
          />
        ) : (
          <span
            className="shrink-0 text-[11px] font-mono px-2 py-1.5 rounded-lg border border-slate-800 bg-slate-950 text-slate-400"
            title="On Linux both user and system paths are saved for this account in ~/.config/env-doctor/env.sh"
          >
            [USR] Saved to env.sh
          </span>
        )}

        <input
          type="text"
          value={newPathInput}
          onChange={(e) => setNewPathInput(e.target.value)}
          placeholder={
            windows
              ? "Enter directory path (e.g., %USERPROFILE%\\.cargo\\bin or C:\\Tools\\bin)"
              : "Enter directory path (e.g., $HOME/.local/bin or /opt/toolchain/bin)"
          }
          className="flex-1 min-w-[220px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
        />

        <button
          type="submit"
          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition"
        >
          + Add Path
        </button>

        <button
          type="button"
          onClick={handleBrowseFolder}
          className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 transition"
        >
          <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
          <span>Browse Folder...</span>
        </button>
      </form>
    </div>
  );
};
