import { create } from "zustand";
import { arrayMove } from "@dnd-kit/sortable";
import {
  apiApplyStagedChanges,
  apiCleanAllPaths,
  apiCreateManualSnapshot,
  apiDeleteProfile,
  apiDeleteSnapshot,
  apiExportEnvironment,
  apiGetDirectoryExecutables,
  apiGetProfiles,
  apiGetSnapshotDiff,
  apiGetSnapshots,
  apiPreviewStagedDiff,
  apiReanalyzeStagedPaths,
  apiResolveNewPathEntry,
  apiRestoreSnapshot,
  apiRunFullDiagnostics,
  apiSaveProfile,
} from "../services/tauriClient";
import {
  isCriticalSystemPath,
  isSessionScope,
  isWindowsPlatform,
  type BinaryConflict,
  type DiagnosticReport,
  type DirectoryExecutable,
  type EnvVariable,
  type EnvironmentProfile,
  type NavTab,
  type OsContext,
  type PathEntry,
  type Scope,
  type ScopeFilter,
  type Snapshot,
  type SnapshotDiff,
  valueLooksExpandable,
} from "../types/ipc";
import {
  fileTimestamp,
  renderDiagnosticReport,
  REPORT_FORMATS,
  type ReportFormat,
} from "../utils/reportExport";
import { saveTextFile } from "../utils/saveFile";
import { confirmAction } from "../utils/confirmAction";

interface HistoryState {
  pathEntries: PathEntry[];
  variables: EnvVariable[];
}

interface SafeGuardWarning {
  rawPath: string;
  resolvedPath: string;
  reason: string;
}

interface ToastMessage {
  id: string;
  type: "success" | "warning" | "error" | "info";
  title: string;
  detail?: string;
}

interface EnvStore {
  // Navigation & UI state
  activeTab: NavTab;
  scopeFilter: ScopeFilter;
  globalSearch: string;
  isLoading: boolean;
  isApplying: boolean;

  // Core data (Baseline vs Staged)
  baselinePaths: PathEntry[];
  baselineVariables: EnvVariable[];
  pathEntries: PathEntry[];
  variables: EnvVariable[];
  conflicts: BinaryConflict[];
  osContext: OsContext;

  // Computed diagnostic metrics
  score: number;
  deadCount: number;
  duplicateCount: number;
  aliasCount: number;
  emptyCount: number;
  unexpandedCount: number;
  securityCount: number;
  /** Hardening notes only: user folders ahead of the system ones. Never scored. */
  orderCount: number;
  /** PATH entries no config file declares (tool/package-manager injections). Never scored. */
  sessionCount: number;
  conflictCount: number;
  stagedChangeCount: number;

  // Undo / Redo stacks
  historyPast: HistoryState[];
  historyFuture: HistoryState[];

  // Right Inspector state
  selectedPathId: string | null;
  selectedDirExecutables: DirectoryExecutable[];
  isLoadingDirExes: boolean;

  // Time Machine & Profiles
  snapshots: Snapshot[];
  selectedSnapshotDiff: SnapshotDiff | null;
  isLoadingDiff: boolean;
  profiles: EnvironmentProfile[];

  // Modals & Toasts
  safeGuardWarning: SafeGuardWarning | null;
  applyDiffPreview: SnapshotDiff | null;
  isApplyModalOpen: boolean;
  toasts: ToastMessage[];

  // Actions
  setActiveTab: (tab: NavTab) => void;
  setScopeFilter: (filter: ScopeFilter) => void;
  setGlobalSearch: (query: string) => void;
  addToast: (type: ToastMessage["type"], title: string, detail?: string) => void;
  dismissToast: (id: string) => void;
  closeSafeGuardModal: () => void;

  // Core lifecycle
  loadDiagnostics: (probeVersions?: boolean) => Promise<void>;
  /** Re-read the OS configuration, confirming first if staged edits would be lost. */
  refreshDiagnostics: (probeVersions?: boolean) => Promise<void>;
  selectPathEntry: (id: string | null) => Promise<void>;

  // Undo / Redo / Reset
  pushHistory: () => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  discardStagedChanges: () => Promise<void>;

  // PATH Editor & Quick Fix mutations
  reorderPathEntries: (activeId: string, overId: string) => Promise<void>;
  movePathEntryToIndex: (
    fromIndex: number,
    toIndex: number,
    /** Bypass the single-mutation guard when called by another action. */
    internal?: boolean
  ) => Promise<void>;
  promoteBinaryInstance: (fromEntryIndex: number, activeEntryIndex: number) => Promise<void>;
  removePathEntry: (
    id: string,
    /** Bypass the single-mutation guard when called by another action. */
    internal?: boolean
  ) => Promise<void>;
  mergeDuplicateEntry: (id: string) => Promise<void>;
  shortenUnexpandedEntry: (id: string, suggested: string) => Promise<void>;
  moveRiskyPathAfterSystem: (id: string) => Promise<void>;
  cleanAllPaths: () => Promise<void>;
  addNewPathEntry: (rawValue: string, scope: Scope) => Promise<void>;
  updatePathEntryValue: (id: string, newRawValue: string) => Promise<void>;

  // Environment Variables mutations
  /** Returns false when the store refused the edit (busy or duplicate row). */
  upsertVariable: (
    variable: EnvVariable,
    originalKey?: string,
    originalScope?: Scope
  ) => boolean;
  /** Returns false when the store refused the edit because it is busy. */
  deleteVariable: (key: string, scope: Scope) => boolean;

  // Apply & Staging workflow
  openApplyModal: () => Promise<void>;
  closeApplyModal: () => void;
  confirmApplyChanges: (snapshotTitle?: string, allowUac?: boolean) => Promise<void>;

  // Time Machine & Profiles
  loadSnapshots: () => Promise<void>;
  createManualSnapshot: (title: string, description: string) => Promise<void>;
  selectSnapshotForDiff: (snapshotId: string) => Promise<void>;
  restoreSnapshot: (snapshotId: string, allowUac?: boolean) => Promise<void>;
  deleteSnapshot: (snapshotId: string) => Promise<void>;

  loadProfiles: () => Promise<void>;
  saveCurrentAsProfile: (name: string, description: string) => Promise<void>;
  applyProfileToStage: (profile: EnvironmentProfile) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  exportEnvironmentText: (format: "json" | "dotenv") => Promise<string>;
  /** Render the current diagnostic state and save it where the user chooses. */
  exportDiagnosticReport: (format: ReportFormat) => Promise<void>;
  importEnvironmentJson: (jsonText: string) => Promise<void>;
}

function totalPathLength(entries: PathEntry[]): number {
  return entries.reduce((acc, entry) => acc + entry.raw_value.length + 1, 0);
}

function countDiagnosticIssues(entries: PathEntry[]) {
  let deadCount = 0;
  let duplicateCount = 0;
  let aliasCount = 0;
  let emptyCount = 0;
  let unexpandedCount = 0;
  let securityCount = 0;
  let orderCount = 0;

  for (const entry of entries) {
    for (const issue of entry.issues) {
      if (issue === "DeadPath") deadCount++;
      else if (issue === "EmptyDirectory") emptyCount++;
      else if (typeof issue === "object" && "Duplicate" in issue) duplicateCount++;
      else if (typeof issue === "object" && "AliasPath" in issue) aliasCount++;
      else if (typeof issue === "object" && "UnexpandedVariable" in issue)
        unexpandedCount++;
      else if (typeof issue === "object" && "SecurityRisk" in issue)
        securityCount++;
      else if (typeof issue === "object" && "OrderRisk" in issue) orderCount++;
    }
  }

  return {
    deadCount,
    duplicateCount,
    aliasCount,
    emptyCount,
    unexpandedCount,
    securityCount,
    orderCount,
    // Entries contributed by the session rather than a config file. They carry no
    // issues by design, so they are counted separately from the findings.
    sessionCount: entries.filter((entry) => isSessionScope(entry.scope)).length,
  };
}

/**
 * The scope of an imported entry, or a safe default.
 *
 * An imported file may come from another machine, another version of the app
 * or a text editor, so the scope has to be validated before it is handed to the
 * backend: a malformed scope would fail the whole import with a message about
 * the data format instead of a hint about what to fix.
 */
function normalizeImportedScope(value: unknown): Scope {
  if (value === "User" || value === "System" || value === "Process") return value;
  if (typeof value === "object" && value !== null && "Dotfile" in value) {
    const dotfile = (
      value as {
        Dotfile?: { file_path?: unknown; line_number?: unknown };
      }
    ).Dotfile;
    if (typeof dotfile?.file_path === "string" && dotfile.file_path.trim()) {
      // Rebuild the object instead of casting the imported one: the backend
      // deserializes a tagged enum, so extra sibling keys or a missing line
      // number would fail the whole command. A line is optional in hand-edited
      // files; keep the location and point at the top of the file.
      const rawLine = dotfile.line_number;
      const parsedLine =
        typeof rawLine === "number"
          ? rawLine
          : typeof rawLine === "string"
            ? Number(rawLine)
            : NaN;
      const lineNumber =
        Number.isSafeInteger(parsedLine) && parsedLine >= 1 ? parsedLine : 1;
      // Windows has no shell dotfiles. An export from Linux describes values
      // declared in one, and the closest thing on Windows is the user hive;
      // keeping the Dotfile scope there would make Apply ignore the value (and
      // treat the user-scoped configuration as empty).
      if (isWindowsPlatform()) return "User";
      return {
        Dotfile: {
          file_path: dotfile.file_path.trim(),
          line_number: lineNumber,
        },
      };
    }
  }
  return "User";
}

/** PATH entries of an imported file, in the shape the backend expects. */
function normalizeImportedEntries(raw: unknown[]): PathEntry[] {
  const entries: PathEntry[] = [];
  // A hand-edited or third-party export can repeat an id. React keys and the
  // staged-diff engine rely on `id` being unique, so a duplicate gets a suffix
  // instead of replacing the row it collides with.
  const usedIds = new Set<string>();
  raw.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const candidate = item as Partial<PathEntry>;
    const rawValue =
      typeof candidate.raw_value === "string" ? candidate.raw_value.trim() : "";
    // An entry without a path cannot be written anywhere; skip it instead of
    // failing the whole import.
    if (!rawValue) return;
    let id =
      typeof candidate.id === "string" && candidate.id
        ? candidate.id
        : `imported-${index}`;
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) suffix++;
      id = `${id}-${suffix}`;
    }
    usedIds.add(id);
    entries.push({
      id,
      raw_value: rawValue,
      // The backend resolves the path again on this machine, so the value in the
      // file is only a placeholder.
      resolved_value:
        typeof candidate.resolved_value === "string"
          ? candidate.resolved_value
          : rawValue,
      scope: normalizeImportedScope(candidate.scope),
      source_text:
        typeof candidate.source_text === "string" && candidate.source_text.trim()
          ? candidate.source_text
          : null,
      exists: false,
      executable_count: 0,
      // The findings are recomputed from the real file system, so nothing is
      // taken over from the file (which may describe another machine).
      issues: [],
    });
  });
  return entries;
}

/**
 * Whether an imported value can safely keep shell expansion enabled.
 *
 * `env.sh` deliberately leaves config-derived templates (`${VAR:-…}`, `$(…)`)
 * expanding, because the quote style in the declaring file expressed that
 * intent. An imported JSON is untrusted text: there is no quote evidence and the
 * `is_expandable` flag comes from the file itself, so a value such as
 * `$(curl … | sh)` would run in every new shell. Values with command
 * substitution are therefore staged as literals; the user can still opt in
 * explicitly in the Variables editor.
 */
function importedValueIsSafeToExpand(value: string): boolean {
  return !value.includes("$(") && !value.includes("`");
}

/** Environment variables of an imported file, in the shape the backend expects. */
function normalizeImportedVariables(raw: unknown[]): EnvVariable[] {
  const variables: EnvVariable[] = [];
  raw.forEach((item) => {
    if (typeof item !== "object" || item === null) return;
    const candidate = item as Partial<EnvVariable>;
    if (typeof candidate.key !== "string" || !candidate.key.trim()) return;
    const value = typeof candidate.value === "string" ? candidate.value : "";
    const requestedExpandable =
      typeof candidate.is_expandable === "boolean"
        ? candidate.is_expandable
        : valueLooksExpandable(value);
    variables.push({
      key: candidate.key.trim(),
      value,
      // A file without the flag is treated like the editor does: a value that
      // uses `$` or a leading `~` stays expandable.
      is_expandable: requestedExpandable && importedValueIsSafeToExpand(value),
      scope: normalizeImportedScope(candidate.scope),
      // An imported value is the user's intent, so it is written as given.
      is_modified:
        typeof candidate.is_modified === "boolean" ? candidate.is_modified : true,
    });
  });

  // Two rows for the same variable cannot both be edited or applied (the
  // registry/config holds one value), and duplicate React keys would drop a
  // row. Keep the last declaration, the way a later assignment wins in a file —
  // but a session row must not shadow a real declaration: Apply skips Process
  // rows, so the declared value would silently never be written.
  const byIdentity = new Map<string, EnvVariable>();
  for (const variable of variables) {
    const identity = variableIdentity(variable);
    const existing = byIdentity.get(identity);
    if (!existing || variable.scope !== "Process" || existing.scope === "Process") {
      byIdentity.set(identity, variable);
    }
  }
  return [...byIdentity.values()];
}

/**
 * Items of a scope the imported file does not describe at all.
 *
 * An import describes the scopes its file was exported from. A Linux export has
 * no `System` entries, and a hand-edited file may contain only one half of the
 * environment. Treating the missing half as "empty" would make Apply delete it:
 * on Windows that means HKCU (or HKLM) loses every variable and the user PATH
 * becomes empty. Keeping the current items of an undescribed scope makes the
 * import replace exactly what it was taken from and nothing else.
 */
function preservedScopeItems<T extends { scope: Scope }>(
  imported: T[],
  current: T[],
  scope: Scope
): T[] {
  if (imported.some((item) => item.scope === scope)) return [];
  return current.filter((item) => item.scope === scope);
}

/**
 * How many things the user has actually changed.
 *
 * Entries carry a stable `id`, so added / removed / edited entries can be
 * compared directly. Position is only compared between entries that exist in
 * both lists: removing one dead path from the middle must not make every later
 * entry look "moved". (Comparing raw index positions, as an earlier version
 * did, counted the whole tail after any insertion or deletion.)
 */
function computeStagedChangeCount(
  basePaths: PathEntry[],
  stagedPaths: PathEntry[],
  baseVars: EnvVariable[],
  stagedVars: EnvVariable[]
): number {
  const baseById = new Map(basePaths.map((entry) => [entry.id, entry]));
  const stagedIds = new Set(stagedPaths.map((entry) => entry.id));

  let changes = 0;

  for (const entry of stagedPaths) {
    const base = baseById.get(entry.id);
    if (
      !base ||
      base.raw_value !== entry.raw_value ||
      JSON.stringify(base.scope) !== JSON.stringify(entry.scope)
    ) {
      changes++;
    }
  }

  // Entries that disappeared from the list are changes too.
  changes += basePaths.filter((entry) => !stagedIds.has(entry.id)).length;

  // Reordering: compare the relative order of the entries that survived.
  const commonBase = basePaths
    .filter((entry) => stagedIds.has(entry.id))
    .map((entry) => entry.id);
  const commonStaged = stagedPaths
    .filter((entry) => baseById.has(entry.id))
    .map((entry) => entry.id);
  for (let i = 0; i < commonStaged.length; i++) {
    if (commonStaged[i] !== commonBase[i]) changes++;
  }

  // Variables are keyed by name (case-insensitively on Windows) and, on
  // Windows, by scope as well: HKCU and HKLM can both define the same name, so
  // keying by name alone would let one row hide the other's edit.
  //
  // Session (Process) rows are not configuration and Apply never writes them.
  // Imports and profiles therefore stage a list without them, and counting the
  // baseline session rows as "removed" would report dozens of pending changes
  // for an import that changes nothing.
  const configuredBaseVars = baseVars.filter((v) => v.scope !== "Process");
  const configuredStagedVars = stagedVars.filter((v) => v.scope !== "Process");
  const baseVarMap = new Map(
    configuredBaseVars.map((v) => [variableIdentity(v), v])
  );
  const stagedKeys = new Set(configuredStagedVars.map(variableIdentity));
  for (const variable of configuredStagedVars) {
    const base = baseVarMap.get(variableIdentity(variable));
    if (
      !base ||
      base.value !== variable.value ||
      base.is_expandable !== variable.is_expandable
    ) {
      changes++;
    }
  }
  changes += configuredBaseVars.filter(
    (v) => !stagedKeys.has(variableIdentity(v))
  ).length;

  return changes;
}

/** Environment variable names are case-insensitive on Windows only. */
function varKey(key: string): string {
  return isWindowsPlatform() ? key.toUpperCase() : key;
}

/**
 * Identity of a variable row. On Windows the registry hives are separate
 * namespaces, so the scope is part of the identity there; elsewhere a name is
 * unique and the scope is only a label.
 */
function variableIdentity(variable: EnvVariable): string {
  const name = varKey(variable.key);
  return isWindowsPlatform()
    ? `${name}\u0000${JSON.stringify(variable.scope)}`
    : name;
}

/**
 * Request token for the Time-Machine diff. A slow response for an earlier click
 * must not overwrite the diff the user selected afterwards.
 */
let snapshotDiffRequest = 0;
/** Snapshot whose diff request is the newest one still in flight. */
let snapshotDiffLoadingId: string | null = null;

/**
 * Whether a staged move would reverse a User/System PATH boundary on Windows.
 *
 * Windows composes the machine-wide System PATH and the per-user PATH into one
 * search order with the System entries first, and Apply writes the two hives
 * separately. Moving one scope across the other in the staged list therefore
 * cannot survive an Apply: `reanalyze_staged_paths` would call the promoted copy
 * active while the registry still resolves the System copy first. Detect the
 * move instead of promising a priority the platform does not provide.
 */
function reversesWindowsPathHives(
  entries: PathEntry[],
  fromIndex: number,
  toIndex: number
): boolean {
  if (!isWindowsPlatform()) return false;
  const moving = entries[fromIndex];
  if (!moving || (moving.scope !== "User" && moving.scope !== "System")) {
    return false;
  }
  const otherScope: Scope = moving.scope === "User" ? "System" : "User";
  const step = fromIndex < toIndex ? 1 : -1;
  for (
    let index = fromIndex + step;
    step > 0 ? index <= toIndex : index >= toIndex;
    index += step
  ) {
    if (entries[index]?.scope === otherScope) return true;
  }
  return false;
}

/** Explanation shown when a drag/promote would cross the Windows PATH hives. */
const WINDOWS_HIVE_ORDER_NOTICE =
  "Windows searches the System PATH before the User PATH and Apply saves the two " +
  "separately, so this order cannot be applied. Reorder entries inside your User " +
  "PATH or the System PATH; to change which copy of a command runs, remove the " +
  "System entry (Apply asks for administrator rights) or add the folder to the " +
  "System PATH.";

/**
 * Keep a staged list in the order Windows actually searches it.
 *
 * Apply writes the System and User hives separately and Windows always searches
 * System first, so a System row listed after the User block would be analysed as
 * low priority while running before every User entry. Every path that builds a
 * list from outside the editor (Add Path, an import, a saved profile) normalises
 * the order once, and the reorder guard refuses to create a different one.
 */
function normalizeWindowsPathOrder(entries: PathEntry[]): PathEntry[] {
  if (!isWindowsPlatform()) return entries;
  const system: PathEntry[] = [];
  const rest: PathEntry[] = [];
  for (const entry of entries) {
    if (entry.scope === "System") system.push(entry);
    else rest.push(entry);
  }
  return [...system, ...rest];
}

/**
 * Request token for the Right-Inspector executable list. `/usr/bin` takes a
 * while to scan, so a fast second click must not be overwritten by the slower
 * first response racing in afterwards.
 */
let dirExecRequest = 0;

/**
 * Re-read the inspector's executable list after the PATH list changed.
 *
 * The list belongs to the selected *entry*, not to its id: an edit can point the
 * same row at another directory, a clean/undo can drop the selected row, and the
 * Inspector would otherwise keep showing the previous folder's executables. A
 * selection that no longer exists is cleared instead of pointing at a ghost row.
 */
async function resyncSelectedEntry(getState: () => EnvStore): Promise<void> {
  const selectedId = getState().selectedPathId;
  if (!selectedId) return;
  const stillExists = getState().pathEntries.some(
    (entry) => entry.id === selectedId
  );
  await getState().selectPathEntry(stillExists ? selectedId : null);
}

/** True while a staging action is recomputing the PATH analysis. */
let stagingBusy = false;
/** Callbacks waiting for the current staging action to finish. */
let stagingIdleWaiters: (() => void)[] = [];

/**
 * Wait until no staging action is mid-reanalysis.
 *
 * A snapshot diff compares a snapshot with the staged state, so reading that
 * state while an edit is still in flight would label the pre-edit list as
 * "current". Waiting is cheap because a staging action normally lasts only as
 * long as one directory scan.
 */
function waitForStagingIdle(): Promise<void> {
  if (!stagingBusy) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const index = stagingIdleWaiters.indexOf(finish);
      if (index >= 0) stagingIdleWaiters.splice(index, 1);
      resolve();
    };
    stagingIdleWaiters.push(finish);
    // A backend call that never settles must not park the Time Machine forever;
    // after this the diff is computed from the last known state instead.
    setTimeout(finish, 5000);
  });
}

/** Wake everything waiting for the staging lock. */
function signalStagingIdle(): void {
  const waiters = stagingIdleWaiters;
  stagingIdleWaiters = [];
  for (const resolve of waiters) resolve();
}

/**
 * Run one staging mutation at a time.
 *
 * Every staging action reads the list, awaits `reanalyze_staged_paths` (a full
 * directory rescan) and then replaces the whole list from its pre-await
 * snapshot. Two actions started in quick succession would build on the same
 * snapshot, so the slower response silently reverted the other edit — and pushed
 * the same state onto the undo stack twice. While one action runs, the next click
 * is told to wait instead of losing either change.
 *
 * `internal` lets an action call another one (`promote` -> `move`, `merge` ->
 * `remove`) without tripping its own guard.
 */
async function withStaging(
  operation: () => Promise<void>,
  internal = false
): Promise<void> {
  if (internal) {
    await operation();
    return;
  }
  if (stagingBusy) {
    useEnvStore.getState().addToast(
      "info",
      "Change In Progress",
      "The previous change is still being re-analyzed. Try again in a moment."
    );
    return;
  }
  const state = useEnvStore.getState();
  if (state.isLoading || state.isApplying) {
    // A reload/Apply is replacing the lists this action would mutate; its
    // pre-await snapshot could otherwise overwrite the fresh state, or the
    // fresh state could overwrite the edit.
    state.addToast(
      "info",
      "Environment Busy",
      "The environment is being reloaded or applied. Try again in a moment."
    );
    return;
  }
  stagingBusy = true;
  try {
    await operation();
  } finally {
    stagingBusy = false;
    signalStagingIdle();
  }
}

/**
 * Unix time (ms) until which file-watcher events are the app's own writes.
 *
 * Apply rewrites `env.sh`, `environment.d/zz-env-doctor.conf` and the managed
 * block inside `~/.bashrc` / `~/.profile`. The watcher sees those writes and
 * would tell the user "configuration files were updated externally, click
 * Refresh" right after they clicked Apply.
 */
let selfWriteQuietUntil = 0;

/** True while a watcher event is the echo of an Apply / Restore. */
export function isOwnConfigWriteEvent(): boolean {
  return Date.now() < selfWriteQuietUntil;
}

export const useEnvStore = create<EnvStore>((set, get) => ({
  activeTab: "doctor",
  scopeFilter: "all",
  globalSearch: "",
  isLoading: true,
  isApplying: false,

  baselinePaths: [],
  baselineVariables: [],
  pathEntries: [],
  variables: [],
  conflicts: [],
  osContext: {
    os_name: "Windows 11",
    os_version: "windows",
    arch: "x86_64",
    total_path_length: 0,
    max_path_length: 4095,
    is_elevated: false,
    shell: "PowerShell / Win32 Registry",
    home_dir: "",
  },

  score: 100,
  deadCount: 0,
  duplicateCount: 0,
  aliasCount: 0,
  emptyCount: 0,
  unexpandedCount: 0,
  securityCount: 0,
  orderCount: 0,
  sessionCount: 0,
  conflictCount: 0,
  stagedChangeCount: 0,

  historyPast: [],
  historyFuture: [],

  selectedPathId: null,
  selectedDirExecutables: [],
  isLoadingDirExes: false,

  snapshots: [],
  selectedSnapshotDiff: null,
  isLoadingDiff: false,
  profiles: [],

  safeGuardWarning: null,
  applyDiffPreview: null,
  isApplyModalOpen: false,
  toasts: [],

  setActiveTab: (tab) => set({ activeTab: tab }),
  setScopeFilter: (filter) => set({ scopeFilter: filter }),
  setGlobalSearch: (query) => set({ globalSearch: query }),

  addToast: (type, title, detail) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, type, title, detail }],
    }));
    // Warnings and errors carry the details of what was skipped or what went
    // wrong (sometimes two sentences), so they stay long enough to read.
    const timeout = type === "success" || type === "info" ? 4500 : 11000;
    setTimeout(() => {
      get().dismissToast(id);
    }, timeout);
  },

  dismissToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  closeSafeGuardModal: () => set({ safeGuardWarning: null }),

  pushHistory: () => {
    const { pathEntries, variables, historyPast } = get();
    set({
      historyPast: [
        ...historyPast.slice(-29),
        {
          pathEntries: structuredClone(pathEntries),
          variables: structuredClone(variables),
        },
      ],
      historyFuture: [],
    });
  },

  loadDiagnostics: async (probeVersions = true) => {
    set({ isLoading: true });
    try {
      const report = await apiRunFullDiagnostics(probeVersions);
      const firstId = report.path_entries[0]?.id ?? null;

      set({
        baselinePaths: structuredClone(report.path_entries),
        baselineVariables: structuredClone(report.variables),
        pathEntries: report.path_entries,
        variables: report.variables,
        conflicts: report.conflicts,
        osContext: report.os_context,
        score: report.score,
        deadCount: report.dead_count,
        duplicateCount: report.duplicate_count,
        aliasCount: report.alias_count,
        emptyCount: report.empty_count,
        unexpandedCount: report.unexpanded_count,
        securityCount: report.security_count,
        orderCount: report.order_count,
        sessionCount: report.session_count,
        conflictCount: report.conflict_count,
        stagedChangeCount: 0,
        historyPast: [],
        historyFuture: [],
        isLoading: false,
      });

      if (firstId) {
        await get().selectPathEntry(firstId);
      }
    } catch (err) {
      set({ isLoading: false });
      get().addToast("error", "Failed to load diagnostic data", String(err));
    }
  },

  refreshDiagnostics: async (probeVersions = true) => {
    if (stagingBusy || get().isLoading || get().isApplying) {
      get().addToast(
        "info",
        "Environment Busy",
        "Wait for the current operation to finish before reloading the environment."
      );
      return;
    }
    const pending = get().stagedChangeCount;
    if (pending > 0) {
      // A rescan replaces the staged list, and the external-change toast even
      // tells the user to click Refresh. Ask before throwing their unapplied
      // work away, exactly like the dedicated Reset action announces it.
      const confirmed = await confirmAction(
        `Reloading re-reads the environment and discards ${pending} staged ${
          pending === 1 ? "change" : "changes"
        } that ${pending === 1 ? "has" : "have"} not been applied yet.`,
        { title: "Discard staged changes and reload?", okLabel: "Discard and reload" }
      );
      if (!confirmed) return;
    }
    await get().loadDiagnostics(probeVersions);
    // The Time-Machine diff compares a snapshot with the current state, and the
    // reload just replaced that state. Recompute it (and refresh the snapshot
    // list, which may also have changed) so the panel does not keep describing
    // the pre-refresh environment.
    if (get().selectedSnapshotDiff) {
      await get().loadSnapshots();
    }
  },

  selectPathEntry: async (id) => {
    // Invalidate any in-flight scan, including the "nothing selected" case.
    const token = ++dirExecRequest;
    set({ selectedPathId: id });
    if (!id) {
      set({ selectedDirExecutables: [], isLoadingDirExes: false });
      return;
    }
    const { pathEntries, conflicts } = get();
    const targetIndex = pathEntries.findIndex((p) => p.id === id);
    if (targetIndex < 0 || !pathEntries[targetIndex].exists) {
      set({ selectedDirExecutables: [], isLoadingDirExes: false });
      return;
    }
    set({ isLoadingDirExes: true });
    try {
      const exes = await apiGetDirectoryExecutables(
        targetIndex,
        pathEntries,
        conflicts
      );
      if (token !== dirExecRequest || get().selectedPathId !== id) return;
      set({ selectedDirExecutables: exes, isLoadingDirExes: false });
    } catch {
      if (token !== dirExecRequest || get().selectedPathId !== id) return;
      set({ selectedDirExecutables: [], isLoadingDirExes: false });
    }
  },

  undo: () => withStaging(async () => {
    const { historyPast, historyFuture, pathEntries, variables } = get();
    if (historyPast.length === 0) return;
    const previous = historyPast[historyPast.length - 1];
    const nextPast = historyPast.slice(0, -1);

    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      previous.pathEntries,
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      previous.variables
    );

    set({
      pathEntries: updatedEntries,
      variables: previous.variables,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
      osContext: {
        ...get().osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
      historyPast: nextPast,
      historyFuture: [
        {
          pathEntries: structuredClone(pathEntries),
          variables: structuredClone(variables),
        },
        ...historyFuture,
      ],
    });
    void resyncSelectedEntry(get);
  }),

  redo: () => withStaging(async () => {
    const { historyPast, historyFuture, pathEntries, variables } = get();
    if (historyFuture.length === 0) return;
    const nextState = historyFuture[0];
    const remainingFuture = historyFuture.slice(1);

    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      nextState.pathEntries,
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      nextState.variables
    );

    set({
      pathEntries: updatedEntries,
      variables: nextState.variables,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
      osContext: {
        ...get().osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
      historyPast: [
        ...historyPast.slice(-29),
        {
          pathEntries: structuredClone(pathEntries),
          variables: structuredClone(variables),
        },
      ],
      historyFuture: remainingFuture,
    });
    void resyncSelectedEntry(get);
  }),

  discardStagedChanges: () => withStaging(async () => {
    const { baselinePaths, baselineVariables } = get();
    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      structuredClone(baselinePaths),
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    set({
      pathEntries: updatedEntries,
      variables: structuredClone(baselineVariables),
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount: 0,
      osContext: {
        ...get().osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
      historyPast: [],
      historyFuture: [],
    });
    void resyncSelectedEntry(get);
    get().addToast("info", "Changes Discarded", "Staged edits have been reset to baseline.");
  }),

  reorderPathEntries: (activeId, overId) =>
    withStaging(async () => {
    if (activeId === overId) return;
    const { pathEntries } = get();
    const oldIndex = pathEntries.findIndex((p) => p.id === activeId);
    const newIndex = pathEntries.findIndex((p) => p.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    if (reversesWindowsPathHives(pathEntries, oldIndex, newIndex)) {
      get().addToast(
        "warning",
        "PATH Order Cannot Be Applied",
        WINDOWS_HIVE_ORDER_NOTICE
      );
      return;
    }

    get().pushHistory();
    const moved = arrayMove(pathEntries, oldIndex, newIndex);
    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      moved,
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      get().variables
    );

    set((state) => ({
      pathEntries: updatedEntries,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
      osContext: {
        ...state.osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
    }));
    // A priority change changes which copy of a command is "active", and the
    // Inspector's executable list carries those badges.
    void resyncSelectedEntry(get);
    }),

  movePathEntryToIndex: (fromIndex, toIndex, internal = false) =>
    withStaging(async () => {
    const { pathEntries } = get();
    if (
      fromIndex < 0 ||
      fromIndex >= pathEntries.length ||
      toIndex < 0 ||
      toIndex >= pathEntries.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    if (reversesWindowsPathHives(pathEntries, fromIndex, toIndex)) {
      get().addToast(
        "warning",
        "PATH Order Cannot Be Applied",
        WINDOWS_HIVE_ORDER_NOTICE
      );
      return;
    }

    get().pushHistory();
    const moved = arrayMove(pathEntries, fromIndex, toIndex);
    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      moved,
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      get().variables
    );

    set({
      pathEntries: updatedEntries,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
    });
    void resyncSelectedEntry(get);
    }, internal),

  promoteBinaryInstance: (fromEntryIndex, activeEntryIndex) =>
    withStaging(async () => {
    const entries = get().pathEntries;
    const targetIdx = Math.max(0, activeEntryIndex);
    if (
      fromEntryIndex < 0 ||
      fromEntryIndex >= entries.length ||
      targetIdx >= entries.length ||
      fromEntryIndex === targetIdx
    ) {
      return;
    }
    if (reversesWindowsPathHives(entries, fromEntryIndex, targetIdx)) {
      get().addToast(
        "warning",
        "Promotion Cannot Change Windows PATH Order",
        WINDOWS_HIVE_ORDER_NOTICE
      );
      return;
    }
    await get().movePathEntryToIndex(fromEntryIndex, targetIdx, true);
    get().addToast(
      "success",
      "Priority Change Staged",
      `Moved selected path to priority #${targetIdx + 1} to activate the binary.`
    );
  }),

  removePathEntry: (id, internal = false) =>
    withStaging(async () => {
    const { pathEntries } = get();
    const target = pathEntries.find((p) => p.id === id);
    if (!target) return;

    // A literal duplicate means the identical path is registered again later in
    // PATH, so the directory stays reachable through the surviving entry and
    // dropping this one is safe even when it names a protected system directory
    // (e.g. `/usr/bin` appearing twice).
    // Note: symlink aliases (`/bin` -> `/usr/bin`) are reported as informational
    // `AliasPath` tips instead, so they never reach this branch.
    const isDuplicate = target.issues.some(
      (i) => typeof i === "object" && i !== null && "Duplicate" in i
    );

    // Section 9.1 Safe Guard: Block deleting critical system paths
    if (
      !isDuplicate &&
      isCriticalSystemPath(target.raw_value, target.resolved_value)
    ) {
      set({
        safeGuardWarning: {
          rawPath: target.raw_value,
          resolvedPath: target.resolved_value,
          reason:
            "This directory is a critical OS system path protected by Safe Guard and cannot be deleted.",
        },
      });
      return;
    }

    get().pushHistory();
    const filtered = pathEntries.filter((p) => p.id !== id);
    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      filtered,
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      get().variables
    );

    const selectionRemoved = get().selectedPathId === id;
    set((state) => ({
      pathEntries: updatedEntries,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
      selectedPathId: selectionRemoved
        ? updatedEntries[0]?.id ?? null
        : state.selectedPathId,
      // Drop the removed folder's executables before the next selection loads,
      // so the Inspector can never render them under another entry's header.
      selectedDirExecutables: selectionRemoved
        ? []
        : state.selectedDirExecutables,
      osContext: {
        ...state.osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
    }));
    if (selectionRemoved) {
      void get().selectPathEntry(get().selectedPathId);
    } else {
      void resyncSelectedEntry(get);
    }
    }, internal),

  mergeDuplicateEntry: (id) =>
    withStaging(async () => {
      await get().removePathEntry(id, true);
      get().addToast(
        "success",
        "Duplicate Path Merged",
        "Kept the higher-priority path entry and removed the duplicate."
      );
    }),

  shortenUnexpandedEntry: (id, suggested) =>
    withStaging(async () => {
    const { pathEntries } = get();
    get().pushHistory();
    const next = pathEntries.map((p) =>
      p.id === id ? { ...p, raw_value: suggested } : p
    );
    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      next,
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      get().variables
    );

    set((state) => ({
      pathEntries: updatedEntries,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
      osContext: {
        ...state.osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
    }));
    get().addToast("success", "Path Shortened", `Shortened to ${suggested}.`);
  }),

  moveRiskyPathAfterSystem: (id) =>
    withStaging(async () => {
    const { pathEntries } = get();
    const idx = pathEntries.findIndex((p) => p.id === id);
    if (idx === -1) return;
    if (idx === pathEntries.length - 1) {
      get().addToast(
        "info",
        "Already Last",
        "This folder is already searched after every other entry."
      );
      return;
    }
    if (reversesWindowsPathHives(pathEntries, idx, pathEntries.length - 1)) {
      get().addToast(
        "warning",
        "PATH Order Cannot Be Applied",
        WINDOWS_HIVE_ORDER_NOTICE
      );
      return;
    }
    await get().movePathEntryToIndex(idx, pathEntries.length - 1, true);
    get().addToast(
      "success",
      "Order Tip Applied (Staged)",
      "Moved this folder below the system folders. Click [Apply] in the header to persist."
    );
  }),

  cleanAllPaths: () =>
    withStaging(async () => {
    const { pathEntries } = get();
    get().pushHistory();
    const cleaned = await apiCleanAllPaths(pathEntries, true);
    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      cleaned,
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      get().variables
    );

    const removedCount = pathEntries.length - updatedEntries.length;
    // Entries that survived but were rewritten to use `$HOME`.
    const before = new Map(pathEntries.map((entry) => [entry.id, entry.raw_value]));
    const shortenedCount = updatedEntries.filter(
      (entry) =>
        before.has(entry.id) && before.get(entry.id) !== entry.raw_value
    ).length;
    set((state) => ({
      pathEntries: updatedEntries,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
      osContext: {
        ...state.osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
    }));
    void resyncSelectedEntry(get);

    const changes: string[] = [];
    if (removedCount > 0) {
      changes.push(
        `Removed ${removedCount} dead or duplicate ${
          removedCount === 1 ? "path" : "paths"
        }`
      );
    }
    if (shortenedCount > 0) {
      changes.push(
        `Rewrote ${shortenedCount} home ${
          shortenedCount === 1 ? "path" : "paths"
        } to use ${isWindowsPlatform() ? "%USERPROFILE%" : "$HOME"}`
      );
    }
    get().addToast(
      "success",
      "One-Click Clean All Staged",
      changes.length > 0
        ? `${changes.join(" and ")}. Click [Apply] to persist.`
        : "There was nothing to clean. Click [Apply] to persist the current PATH."
    );
  }),

  addNewPathEntry: (rawValue, scope) =>
    withStaging(async () => {
    const trimmed = rawValue.trim();
    if (!trimmed) return;

    try {
      get().pushHistory();
      const entry = await apiResolveNewPathEntry(trimmed, scope);
      // A new System entry belongs in the System block, not after the User
      // entries: that is the order Windows searches, and it is the only order
      // the reorder guard would allow afterwards.
      const next = normalizeWindowsPathOrder([...get().pathEntries, entry]);
      const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
        next,
        false
      );
      const counts = countDiagnosticIssues(updatedEntries);
      const stagedChangeCount = computeStagedChangeCount(
        get().baselinePaths,
        updatedEntries,
        get().baselineVariables,
        get().variables
      );

      set((state) => ({
        pathEntries: updatedEntries,
        conflicts,
        score,
        ...counts,
        conflictCount: conflicts.length,
        stagedChangeCount,
        selectedPathId: entry.id,
        osContext: {
          ...state.osContext,
          total_path_length: totalPathLength(updatedEntries),
        },
      }));
      // The new row is selected; load its executables instead of leaving the
      // Inspector with the previous selection's list.
      void get().selectPathEntry(entry.id);
      get().addToast("success", "New PATH Entry Added", trimmed);
    } catch (err) {
      get().addToast("error", "Failed to Add Path", String(err));
    }
    }),

  updatePathEntryValue: (id, newRawValue) =>
    withStaging(async () => {
    const trimmed = newRawValue.trim();
    if (!trimmed) return;
    const { pathEntries } = get();
    const target = pathEntries.find((p) => p.id === id);
    if (!target) return;

    try {
      get().pushHistory();
      const resolvedEntry = await apiResolveNewPathEntry(trimmed, target.scope);
      const next = pathEntries.map((p) =>
        p.id === id ? { ...resolvedEntry, id } : p
      );
      const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
        next,
        false
      );
      const counts = countDiagnosticIssues(updatedEntries);
      const stagedChangeCount = computeStagedChangeCount(
        get().baselinePaths,
        updatedEntries,
        get().baselineVariables,
        get().variables
      );

      set((state) => ({
        pathEntries: updatedEntries,
        conflicts,
        score,
        ...counts,
        conflictCount: conflicts.length,
        stagedChangeCount,
        osContext: {
          ...state.osContext,
          total_path_length: totalPathLength(updatedEntries),
        },
      }));
      if (get().selectedPathId === id) {
        void get().selectPathEntry(id);
      }
    } catch (err) {
      get().addToast("error", "Failed to Update Path", String(err));
    }
    }),

  upsertVariable: (variable, originalKey, originalScope) => {
    if (stagingBusy || get().isLoading || get().isApplying) {
      // An import or profile switch in flight replaces the whole variable list
      // when its re-analysis finishes, so a synchronous edit would be lost.
      get().addToast(
        "info",
        "Change In Progress",
        "Wait for the current operation to finish before editing a variable."
      );
      return false;
    }
    const { variables, baselinePaths, pathEntries, baselineVariables } = get();
    const windows = isWindowsPlatform();

    const updatedVar: EnvVariable = {
      ...variable,
      // The flag is the caller's decision. Forcing expansion on whenever the
      // text contains a `$` would make it impossible to store a literal token
      // such as `pa$$word`, and Apply would expand it in every new shell.
      is_expandable: variable.is_expandable,
      is_modified: true,
    };

    // The row an edit came from is identified by its *old* key and scope, not by
    // the values the dialog currently holds. Matching on the new identity is
    // what made a scope change (User -> System) prepend a second row instead of
    // moving the original, and made a rename onto an existing key keep both.
    // A new variable (no `originalKey`) still matches on its own key and scope,
    // so adding a User variable never overwrites the System one of that name.
    const matchScope =
      originalKey === undefined ? variable.scope : originalScope ?? variable.scope;
    const sameRow = (candidate: EnvVariable) =>
      varKey(candidate.key) === varKey(originalKey ?? variable.key) &&
      (!windows ||
        JSON.stringify(candidate.scope) === JSON.stringify(matchScope));
    const sourceIdx = variables.findIndex(sameRow);
    const targetIdentity = variableIdentity(updatedVar);
    const collision = variables.find(
      (candidate, index) =>
        index !== sourceIdx && variableIdentity(candidate) === targetIdentity
    );

    // Renaming or moving a variable onto a name that already exists in the same
    // scope has no single correct meaning, and keeping both would make Apply
    // write two rows for one registry value. Refuse and leave the state alone.
    if (collision) {
      get().addToast(
        "error",
        "Variable Already Exists",
        `'${variable.key}' is already defined in that scope. Delete the existing row first, or choose another name.`
      );
      return false;
    }

    get().pushHistory();

    let nextVars: EnvVariable[];
    if (sourceIdx >= 0) {
      nextVars = variables.map((candidate, index) =>
        index === sourceIdx ? updatedVar : candidate
      );
    } else {
      nextVars = [updatedVar, ...variables];
    }

    const stagedChangeCount = computeStagedChangeCount(
      baselinePaths,
      pathEntries,
      baselineVariables,
      nextVars
    );

    set({ variables: nextVars, stagedChangeCount });
    const renamed = originalKey !== undefined && originalKey !== variable.key;
    const movedScope =
      originalScope !== undefined &&
      JSON.stringify(originalScope) !== JSON.stringify(variable.scope);
    get().addToast(
      "success",
      renamed || movedScope
        ? `Variable '${originalKey ?? variable.key}' staged as '${variable.key}'`
        : `Variable '${variable.key}' staged`
    );
    return true;
  },

  deleteVariable: (key, scope) => {
    if (stagingBusy || get().isLoading || get().isApplying) {
      get().addToast(
        "info",
        "Change In Progress",
        "Wait for the current operation to finish before editing a variable."
      );
      return false;
    }
    get().pushHistory();
    const { variables, baselinePaths, pathEntries, baselineVariables } = get();
    const nextVars = variables.filter(
      (v) => !(v.key === key && JSON.stringify(v.scope) === JSON.stringify(scope))
    );
    const stagedChangeCount = computeStagedChangeCount(
      baselinePaths,
      pathEntries,
      baselineVariables,
      nextVars
    );
    set({ variables: nextVars, stagedChangeCount });
    get().addToast("info", `Removal of '${key}' staged`);
    return true;
  },

  openApplyModal: async () => {
    if (
      stagingBusy ||
      get().isLoading ||
      get().isApplying
    ) {
      // The preview would show a list from before the in-flight operation.
      get().addToast(
        "info",
        "Environment Busy",
        "Wait for the current operation to finish, then review the diff."
      );
      return;
    }
    const { pathEntries, variables } = get();
    try {
      const diff = await apiPreviewStagedDiff(pathEntries, variables);
      // A staging action can start while the preview is being computed (the page
      // is not covered yet), so the diff may describe a list that no longer
      // exists. Do not show a review that would not match what Apply writes.
      if (
        stagingBusy ||
        get().pathEntries !== pathEntries ||
        get().variables !== variables
      ) {
        get().addToast(
          "info",
          "Staged State Changed",
          "The environment changed while the diff was being prepared. Review it again."
        );
        return;
      }
      set({ applyDiffPreview: diff, isApplyModalOpen: true });
    } catch (err) {
      get().addToast("error", "Failed to generate Diff preview", String(err));
    }
  },

  closeApplyModal: () => set({ isApplyModalOpen: false }),

  confirmApplyChanges: async (snapshotTitle, allowUac = true) => {
    if (stagingBusy || get().isLoading || get().isApplying) {
      // The reviewed diff was taken before the in-flight operation; applying
      // now would persist a state the user never saw.
      get().addToast(
        "info",
        "Environment Busy",
        "Wait for the current operation to finish, then review the diff again."
      );
      return;
    }
    const { pathEntries, variables } = get();
    set({ isApplying: true });
    // The watcher can deliver the echo of a write *before* the IPC call
    // resolves. Open the quiet window up front so Apply never asks the user to
    // "refresh" because of its own files; extend it again after the write.
    selfWriteQuietUntil = Date.now() + 5000;
    try {
      const result = await apiApplyStagedChanges({
        path_entries: pathEntries,
        variables,
        snapshot_title: snapshotTitle,
        allow_uac_elevation: allowUac,
      });

      selfWriteQuietUntil = Date.now() + 5000;
      set({ isApplying: false, isApplyModalOpen: false });
      get().addToast(
        "success",
        "Applied & Backed Up",
        result.broadcasted
          ? result.message
          : `${result.message} Apps that were already running keep the old environment until they are restarted.`
      );

      // Apply warnings are not always about permissions: on Linux they explain
      // which runtime folders were left out on purpose and why. Only the Windows
      // UAC note is permission-related, and its text says so.
      for (const warn of result.warnings) {
        get().addToast("warning", "Apply Notice", warn);
      }

      await get().loadDiagnostics(false);
      await get().loadSnapshots();
    } catch (err) {
      set({ isApplying: false });
      get().addToast("error", "Failed to Apply Changes", String(err));
    }
  },

  loadSnapshots: async () => {
    try {
      // Do not compare a snapshot with a list that is still being recomputed.
      await waitForStagingIdle();
      const snaps = await apiGetSnapshots();
      // A diff compares a snapshot with the current staged state, so it must be
      // recomputed whenever the current state or the snapshot list changes:
      // after Apply, after a rollback, and when the Time Machine is opened with
      // staged edits pending. Keeping the old result would label state from an
      // earlier point in time as "vs Current Staged State".
      const previousId = get().selectedSnapshotDiff?.snapshot_id;
      const selectedId =
        previousId && snaps.some((snapshot) => snapshot.id === previousId)
          ? previousId
          : snaps[0]?.id;
      set({ snapshots: snaps });
      if (selectedId) {
        await get().selectSnapshotForDiff(selectedId);
      } else {
        snapshotDiffRequest++;
        snapshotDiffLoadingId = null;
        set({ selectedSnapshotDiff: null, isLoadingDiff: false });
      }
    } catch (err) {
      get().addToast("error", "Failed to Load Snapshots", String(err));
    }
  },

  createManualSnapshot: async (title, description) => {
    try {
      // The backend reads the live environment; staged edits that were never
      // applied are deliberately not part of a Time-Machine backup.
      const created = await apiCreateManualSnapshot(title, description);
      const snaps = await apiGetSnapshots();
      set({ snapshots: snaps });
      await get().selectSnapshotForDiff(created.id);
      get().addToast("success", "Snapshot Created", `Saved '${created.title}'.`);
    } catch (err) {
      get().addToast("error", "Failed to Create Snapshot", String(err));
    }
  },

  selectSnapshotForDiff: async (snapshotId) => {
    // A diff describes the staged state at the moment it was requested. Retry if
    // that state changed while the request was in flight (an Apply or Refresh
    // reload can finish mid-request); otherwise the panel would keep a
    // comparison against a list that no longer exists.
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitForStagingIdle();
      const pathEntries = get().pathEntries;
      const variables = get().variables;
      const token = ++snapshotDiffRequest;
      snapshotDiffLoadingId = snapshotId;
      set({ isLoadingDiff: true });
      try {
        const diff = await apiGetSnapshotDiff(snapshotId, pathEntries, variables);
        if (token !== snapshotDiffRequest) return;
        if (
          get().pathEntries !== pathEntries ||
          get().variables !== variables
        ) {
          continue;
        }
        snapshotDiffLoadingId = null;
        set({ selectedSnapshotDiff: diff, isLoadingDiff: false });
        return;
      } catch (err) {
        if (token !== snapshotDiffRequest) return;
        snapshotDiffLoadingId = null;
        set({ isLoadingDiff: false });
        get().addToast("error", "Failed to Compute Diff", String(err));
        return;
      }
    }
    snapshotDiffLoadingId = null;
    set({ isLoadingDiff: false });
    get().addToast(
      "info",
      "Diff Not Up To Date",
      "The environment kept changing while the diff was being computed. Select the snapshot again."
    );
  },

  restoreSnapshot: async (snapshotId, allowUac = true) => {
    if (stagingBusy || get().isApplying || get().isLoading) {
      // A staged mutation or a reload still in flight would write its result
      // over the state this restore reloads.
      get().addToast(
        "info",
        "Environment Busy",
        "Wait for the current operation to finish before restoring a snapshot."
      );
      return;
    }
    set({ isApplying: true });
    // Same race as Apply: the watcher may echo the restored files before the
    // command returns.
    selfWriteQuietUntil = Date.now() + 5000;
    try {
      const res = await apiRestoreSnapshot(snapshotId, allowUac);
      selfWriteQuietUntil = Date.now() + 5000;
      set({ isApplying: false });
      get().addToast("success", "Time-Machine Rollback Complete", res.message);
      await get().loadDiagnostics(false);
      await get().loadSnapshots();
    } catch (err) {
      set({ isApplying: false });
      get().addToast("error", "Snapshot Rollback Failed", String(err));
    }
  },

  deleteSnapshot: async (snapshotId) => {
    try {
      await apiDeleteSnapshot(snapshotId);
      const snaps = await apiGetSnapshots();
      // Decide from the state *after* both awaits: a diff request can finish
      // while the delete runs, so a selection captured earlier may be stale.
      const deletedSelected =
        get().selectedSnapshotDiff?.snapshot_id === snapshotId;
      // A diff request for the deleted snapshot must not repopulate the panel
      // after the list changed. It only needs cancelling when it is still the
      // newest request; a later click has already superseded it.
      const cancelledLoading = snapshotDiffLoadingId === snapshotId;
      if (cancelledLoading) {
        snapshotDiffRequest++;
        snapshotDiffLoadingId = null;
      }
      set((state) => ({
        snapshots: snaps,
        isLoadingDiff: cancelledLoading ? false : state.isLoadingDiff,
        selectedSnapshotDiff: deletedSelected
          ? null
          : state.selectedSnapshotDiff,
      }));
      if (deletedSelected && snaps[0]) {
        await get().selectSnapshotForDiff(snaps[0].id);
      }
      get().addToast("info", "Snapshot Deleted");
    } catch (err) {
      get().addToast("error", "Failed to Delete Snapshot", String(err));
    }
  },

  loadProfiles: async () => {
    try {
      const profiles = await apiGetProfiles();
      set({ profiles });
    } catch (err) {
      get().addToast("error", "Failed to Load Profiles", String(err));
    }
  },

  saveCurrentAsProfile: async (name, description) => {
    const { variables, pathEntries } = get();
    try {
      const userAndSysVars = variables.filter((v) => v.scope !== "Process");
      await apiSaveProfile(name, description, userAndSysVars, pathEntries);
      const profiles = await apiGetProfiles();
      set({ profiles });
      get().addToast("success", "Environment Profile Saved", `Created profile '${name}'.`);
    } catch (err) {
      get().addToast("error", "Failed to Save Profile", String(err));
    }
  },

  applyProfileToStage: (profile) =>
    withStaging(async () => {
    get().pushHistory();
    const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
      normalizeWindowsPathOrder(structuredClone(profile.path_entries)),
      false
    );
    const counts = countDiagnosticIssues(updatedEntries);
    const stagedVars = profile.variables.map((v) => ({
      ...v,
      is_modified: true,
    }));
    const stagedChangeCount = computeStagedChangeCount(
      get().baselinePaths,
      updatedEntries,
      get().baselineVariables,
      stagedVars
    );

    set({
      pathEntries: updatedEntries,
      variables: stagedVars,
      conflicts,
      score,
      ...counts,
      conflictCount: conflicts.length,
      stagedChangeCount,
      osContext: {
        ...get().osContext,
        total_path_length: totalPathLength(updatedEntries),
      },
    });
    void resyncSelectedEntry(get);
    get().addToast(
      "success",
      `Profile '${profile.name}' Staged`,
      "Click [Apply] in the header to persist to your system."
    );
  }),

  deleteProfile: async (profileId) => {
    try {
      await apiDeleteProfile(profileId);
      const profiles = await apiGetProfiles();
      set({ profiles });
      get().addToast("info", "Profile Deleted");
    } catch (err) {
      get().addToast("error", "Failed to Delete Profile", String(err));
    }
  },

  exportEnvironmentText: async (format) => {
    const { pathEntries, variables } = get();
    return apiExportEnvironment(format, pathEntries, variables);
  },

  exportDiagnosticReport: async (format) => {
    const state = get();
    const meta = REPORT_FORMATS.find((candidate) => candidate.id === format);
    if (!meta) return;

    // The report mirrors what is on screen, staged edits included.
    const report: DiagnosticReport = {
      score: state.score,
      dead_count: state.deadCount,
      duplicate_count: state.duplicateCount,
      alias_count: state.aliasCount,
      empty_count: state.emptyCount,
      unexpanded_count: state.unexpandedCount,
      security_count: state.securityCount,
      order_count: state.orderCount,
      session_count: state.sessionCount,
      conflict_count: state.conflictCount,
      path_entries: state.pathEntries,
      conflicts: state.conflicts,
      variables: state.variables,
      os_context: state.osContext,
    };

    try {
      const contents = renderDiagnosticReport(format, report, {
        stagedChangeCount: state.stagedChangeCount,
      });
      const result = await saveTextFile({
        defaultName: `env-doctor-report-${fileTimestamp()}.${meta.extension}`,
        contents,
        filterName: meta.filterName,
        extension: meta.extension,
        mimeType: meta.mimeType,
      });
      if (!result.saved) {
        get().addToast("info", "Export Cancelled", "No file was written.");
        return;
      }
      get().addToast(
        "success",
        `${meta.label} exported`,
        `${result.location} (${result.bytes} bytes)`
      );
    } catch (err) {
      get().addToast("error", "Export Failed", String(err));
    }
  },

  importEnvironmentJson: (jsonText) =>
    withStaging(async () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed.path_entries) || !Array.isArray(parsed.variables)) {
        throw new Error("Invalid Env & PATH Doctor JSON export format.");
      }
      // The file may have been hand-edited or exported by an older version, so
      // the fields the backend insists on are filled in here instead of letting
      // the deserializer fail with an opaque message.
      const entries = normalizeImportedEntries(parsed.path_entries);
      const variables = normalizeImportedVariables(parsed.variables);
      // A file exported on Linux contains no System-scoped entries, and a
      // hand-edited file can omit either hive. An absent scope does not mean
      // "delete it": Apply writes exactly the staged list, so an empty User
      // list would clear the user PATH and every user variable, and an empty
      // System list would delete ComSpec, OS, TEMP and the system PATH.
      // Preserve the current items of a scope the file does not describe, and
      // keep the Windows search order (System PATH before User PATH).
      const stateBeforeImport = get();
      const preservedSystemEntries = preservedScopeItems(
        entries,
        stateBeforeImport.pathEntries,
        "System"
      );
      const preservedUserEntries = preservedScopeItems(
        entries,
        stateBeforeImport.pathEntries,
        "User"
      );
      const preservedSystemVariables = preservedScopeItems(
        variables,
        stateBeforeImport.variables,
        "System"
      );
      const preservedUserVariables = preservedScopeItems(
        variables,
        stateBeforeImport.variables,
        "User"
      );
      // An empty array means the file does not describe that half of the
      // configuration at all (a variables-only export, or a hand-edited file).
      // On Linux the scanned rows are `Dotfile`-scoped, so the per-scope guard
      // above cannot see them; preserving the whole list is what keeps a partial
      // import from emptying the staged PATH or the env.sh variables.
      const mergedEntries =
        entries.length === 0
          ? stateBeforeImport.pathEntries
          : normalizeWindowsPathOrder([
              ...preservedSystemEntries,
              ...entries,
              ...preservedUserEntries,
            ]);
      const mergedVariables =
        variables.length === 0
          ? stateBeforeImport.variables
          : [...preservedSystemVariables, ...variables, ...preservedUserVariables];
      get().pushHistory();
      const [score, updatedEntries, conflicts] = await apiReanalyzeStagedPaths(
        mergedEntries,
        false
      );
      const counts = countDiagnosticIssues(updatedEntries);
      const stagedChangeCount = computeStagedChangeCount(
        get().baselinePaths,
        updatedEntries,
        get().baselineVariables,
        mergedVariables
      );
      set({
        pathEntries: updatedEntries,
        variables: mergedVariables,
        conflicts,
        score,
        ...counts,
        conflictCount: conflicts.length,
        stagedChangeCount,
        osContext: {
          ...get().osContext,
          total_path_length: totalPathLength(updatedEntries),
        },
      });
      void resyncSelectedEntry(get);
      get().addToast(
        "success",
        "JSON Environment Imported",
        "Imported configuration is staged. Review the Diff and click [Apply]."
      );
    } catch (err) {
      get().addToast("error", "JSON Import Failed", String(err));
    }
    }),
}));

/**
 * A failed action must not disappear.
 *
 * The store actions are started from click handlers without `await`, so a
 * rejection (an IPC error, a backend panic, a failed re-analysis) would never
 * reach a `catch` block and the user would only see that "nothing happened".
 * Reporting it here covers every action at once.
 */
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    if (reason === undefined || reason === null) return;
    useEnvStore.getState().addToast("error", "The Action Failed", String(reason));
  });
}
