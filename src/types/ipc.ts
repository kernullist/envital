export type Scope =
  | "User"
  | "System"
  | "Process"
  | {
      Dotfile: {
        file_path: string;
        line_number: number;
        /**
         * Present (and `true`) when the declaration was double-quoted, so the
         * backend expanded it and `raw_value` holds the resolved directory
         * rather than the text written in the file. Apply writes such a folder
         * as data instead of replaying the template.
         */
        expanded?: boolean;
      };
    };

export type DiagnosticIssue =
  | "DeadPath"
  | { Duplicate: { first_seen_index: number } }
  | { AliasPath: { canonical: string; first_seen_index: number } }
  | "EmptyDirectory"
  | { UnexpandedVariable: { suggested: string } }
  | { SecurityRisk: { reason: string } }
  | { OrderRisk: { reason: string } };

/**
 * True when the issue is only an informational symlink-alias note.
 * Aliases are never penalised by the health score and are never merged
 * automatically, so they must not be surfaced as warnings.
 */
export function isAliasIssue(issue: DiagnosticIssue): boolean {
  return typeof issue === "object" && issue !== null && "AliasPath" in issue;
}

export interface PathEntry {
  id: string;
  raw_value: string;
  resolved_value: string;
  scope: Scope;
  /**
   * The entry exactly as written in the config file it was declared in (for
   * example `$HOME/.cargo/bin`). `null` for entries that no readable config file
   * declares — those are session/runtime injections (see `isSessionScope`).
   */
  source_text: string | null;
  exists: boolean;
  executable_count: number;
  issues: DiagnosticIssue[];
}

/**
 * True when the entry was contributed by the running process/session rather than
 * declared in a configuration file. The backend runs no diagnostic rules on these
 * entries and excludes them from the health score, so the UI lists them apart.
 */
export function isSessionScope(scope: Scope): boolean {
  return scope === "Process";
}

/**
 * True when a PATH entry contains nothing to fix: either the backend added no
 * issue, or every issue is informational (symlink alias) or a free hardening tip.
 */
export function isUnscoredIssue(issue: DiagnosticIssue): boolean {
  return (
    isAliasIssue(issue) ||
    (typeof issue === "object" && issue !== null && "OrderRisk" in issue)
  );
}

export interface BinaryInstance {
  full_path: string;
  path_entry_index: number;
  is_active: boolean;
  version_hint: string | null;
}

export interface BinaryConflict {
  binary_name: string;
  locations: BinaryInstance[];
}

export interface EnvVariable {
  key: string;
  value: string;
  is_expandable: boolean;
  scope: Scope;
  is_modified: boolean;
}

export interface DirectoryExecutable {
  name: string;
  full_path: string;
  version_hint: string | null;
  is_shadowed: boolean;
  active_path: string | null;
}

export interface OsContext {
  os_name: string;
  os_version: string;
  arch: string;
  total_path_length: number;
  max_path_length: number;
  is_elevated: boolean;
  shell: string;
  home_dir: string;
}

export interface DiagnosticReport {
  score: number;
  dead_count: number;
  duplicate_count: number;
  alias_count: number;
  empty_count: number;
  unexpanded_count: number;
  security_count: number;
  /** Hardening notes: user folders searched ahead of the system ones. Free (no score effect). */
  order_count: number;
  /** PATH entries no config file declares (tool/package-manager injections). Excluded from the score. */
  session_count: number;
  conflict_count: number;
  path_entries: PathEntry[];
  conflicts: BinaryConflict[];
  variables: EnvVariable[];
  os_context: OsContext;
}

/** Result of writing an exported report to disk. */
export interface ExportFileOutcome {
  path: string;
  bytes: number;
}

export interface Snapshot {
  id: string;
  created_at: string;
  title: string;
  description: string;
  is_automatic: boolean;
  path_count: number;
  var_count: number;
  path_entries: PathEntry[];
  variables: EnvVariable[];
}

export interface DiffLine {
  change_type: "added" | "removed" | "unchanged";
  old_index: number | null;
  new_index: number | null;
  content: string;
  scope_label: string;
}

export interface VarDiff {
  key: string;
  change_type: "added" | "removed" | "modified";
  old_value: string | null;
  new_value: string | null;
  scope_label: string;
}

export interface SnapshotDiff {
  snapshot_id: string;
  snapshot_title: string;
  created_at: string;
  unified_diff: string;
  path_diffs: DiffLine[];
  var_diffs: VarDiff[];
}

export interface EnvironmentProfile {
  id: string;
  name: string;
  description: string;
  created_at: string;
  variables: EnvVariable[];
  path_entries: PathEntry[];
}

export interface ApplyChangesPayload {
  path_entries: PathEntry[];
  variables: EnvVariable[];
  snapshot_title?: string;
  allow_uac_elevation: boolean;
}

export interface ApplyChangesResult {
  success: boolean;
  snapshot_id: string;
  broadcasted: boolean;
  message: string;
  warnings: string[];
}

export type NavTab =
  | "doctor"
  | "path-editor"
  | "shadowing"
  | "variables"
  | "timemachine"
  | "profiles";

export type ScopeFilter = "all" | "user" | "system" | "dotfile" | "session";

const SECRET_KEYWORDS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "PRIVATE",
  "AUTH",
  "API_KEY",
];

/** Replacement shown instead of a credential-like value. */
export const SECRET_MASK = "••••••••";

/** Section 9.3: Detect sensitive environment variable names for secret masking */
export function isSecretVariableKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_KEYWORDS.some((kw) => upper.includes(kw));
}

/**
 * The text a diff/list may show for one variable value.
 *
 * Every view that renders values uses this, so a credential-like name can never
 * leak through one panel while another hides it: the Variables list, the
 * Time-Machine diff and the pre-Apply diff all mask the same keys. `null` means
 * "the variable does not exist on this side", and an empty value is labelled so
 * a changed value does not look like a missing line.
 */
export function displayVariableValue(key: string, value: string | null): string {
  if (value === null) return "";
  if (isSecretVariableKey(key)) return SECRET_MASK;
  return value === "" ? "(empty)" : value;
}

/**
 * Whether the UI is running on Windows. Used for *wording* only (registry paths,
 * example placeholders); behaviour is decided by the Rust backend.
 */
export function isWindowsPlatform(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/**
 * Whether a value contains syntax the platform will expand when it is loaded.
 *
 * Windows expands `%VAR%` in a REG_EXPAND_SZ value; on Linux the shell expands
 * `$VAR` and a leading `~` when it sources `env.sh`. Keeping this in one place
 * means the editor, the store and the report all agree on what "expandable"
 * means on the current machine.
 */
export function valueLooksExpandable(value: string): boolean {
  if (isWindowsPlatform()) return value.includes("%");
  return value.includes("$") || value.trimStart().startsWith("~");
}

/** Section 9.1: Client-side check for critical OS system paths that must never be deleted */
export function isCriticalSystemPath(raw: string, resolved: string): boolean {
  const normRaw = raw.trim().replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
  const normRes = resolved
    .trim()
    .replace(/\//g, "\\")
    .toLowerCase()
    .replace(/\\+$/, "");

  const winProtected = [
    "c:\\windows\\system32",
    "c:\\windows",
    "c:\\windows\\system32\\wbem",
    "c:\\windows\\system32\\windowspowershell\\v1.0",
    "%systemroot%\\system32",
    "%systemroot%",
    "%windir%\\system32",
    "%windir%",
  ];

  const unixProtected = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

  return (
    winProtected.includes(normRaw) ||
    winProtected.includes(normRes) ||
    unixProtected.includes(raw.trim().replace(/\/+$/, "")) ||
    unixProtected.includes(resolved.trim().replace(/\/+$/, ""))
  );
}

/**
 * Whether a configuration file is one the app writes itself (`env.sh` and its
 * `environment.d` mirror). Mirrors `is_app_generated_config` in the Rust backend.
 */
export function isAppManagedConfigFile(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, "/").split("/");
  const name = segments.pop() ?? "";
  const parent = segments.pop() ?? "";
  return (
    (name === "env.sh" && parent === "env-doctor") ||
    ((name === "zz-env-doctor.conf" || name === "99-env-doctor.conf") &&
      parent === "environment.d")
  );
}

/** Format Scope badge label and detail string */
export function formatScopeInfo(scope: Scope): {
  badge: string;
  sourceText: string;
  vscodeUrl: string | null;
  kind: "user" | "system" | "process" | "dotfile";
} {
  // Wording only: on Linux there is no HKCU/HKLM. A path added from the UI uses
  // the "User" scope, and the inspector must not tell a Linux user to edit a
  // Windows registry key.
  const windows = isWindowsPlatform();
  if (scope === "User") {
    return {
      badge: "USR",
      sourceText: windows
        ? "HKCU\\Environment (User Scope)"
        : "User-level setting (saved to ~/.config/env-doctor/env.sh on Apply)",
      vscodeUrl: null,
      kind: "user",
    };
  }
  if (scope === "System") {
    return {
      badge: "SYS",
      sourceText: windows
        ? "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"
        : "System-wide label (label only: Apply writes it to your ~/.config/env-doctor/env.sh)",
      vscodeUrl: null,
      kind: "system",
    };
  }
  if (scope === "Process") {
    return {
      badge: "PROC",
      sourceText: "Current session (no config file declares it)",
      vscodeUrl: null,
      kind: "process",
    };
  }
  const { file_path, line_number } = scope.Dotfile;
  const normalizedPath = file_path.replace(/\\/g, "/");
  const baseName = normalizedPath.split("/").pop() || normalizedPath;
  // Encode each path segment, not the whole string: `encodeURI` leaves `#` and
  // `?` alone, so a folder containing one would end the URL early and the deep
  // link would open nothing (a space had the same effect before). The leading
  // separator is dropped because the URL already ends with `/`.
  const encodedPath = normalizedPath
    .replace(/^\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return {
    badge: `${baseName}:${line_number}`,
    sourceText: `${file_path} (Line ${line_number})`,
    vscodeUrl: `vscode://file/${encodedPath}:${line_number}`,
    kind: "dotfile",
  };
}
