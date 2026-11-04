import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyChangesPayload,
  ApplyChangesResult,
  BinaryConflict,
  DiagnosticReport,
  DirectoryExecutable,
  EnvVariable,
  EnvironmentProfile,
  ExportFileOutcome,
  PathEntry,
  Scope,
  Snapshot,
  SnapshotDiff,
} from "../types/ipc";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Fallback mock state when opened in a pure browser tab during UI preview
const FALLBACK_REPORT: DiagnosticReport = {
  score: 78,
  dead_count: 2,
  duplicate_count: 1,
  alias_count: 1,
  empty_count: 1,
  unexpanded_count: 1,
  security_count: 0,
  order_count: 1,
  session_count: 1,
  conflict_count: 3,
  os_context: {
    os_name: "Windows 11",
    os_version: "windows",
    arch: "x86_64",
    total_path_length: 1420,
    max_path_length: 4095,
    is_elevated: false,
    shell: "PowerShell / CMD (Win32 Registry)",
    home_dir: "C:\\Users\\Developer",
  },
  path_entries: [
    {
      id: "sys-0",
      raw_value: "C:\\Windows\\System32",
      resolved_value: "C:\\Windows\\System32",
      scope: "System",
      source_text: null,
      exists: true,
      executable_count: 642,
      issues: [],
    },
    {
      id: "sys-1",
      raw_value: "C:\\Program Files\\nodejs",
      resolved_value: "C:\\Program Files\\nodejs",
      scope: "System",
      source_text: null,
      exists: true,
      executable_count: 6,
      issues: [],
    },
    {
      id: "sys-2",
      raw_value: "C:\\Program Files\\Python39",
      resolved_value: "C:\\Program Files\\Python39",
      scope: "System",
      source_text: null,
      exists: true,
      executable_count: 12,
      issues: [],
    },
    {
      id: "usr-0",
      raw_value: "C:\\Old_SDK\\bin",
      resolved_value: "C:\\Old_SDK\\bin",
      scope: "User",
      source_text: null,
      exists: false,
      executable_count: 0,
      issues: ["DeadPath"],
    },
    {
      id: "usr-1",
      raw_value: "C:\\Users\\Developer\\AppData\\Local\\Programs\\Python\\Python312",
      resolved_value:
        "C:\\Users\\Developer\\AppData\\Local\\Programs\\Python\\Python312",
      scope: "User",
      source_text: null,
      exists: true,
      executable_count: 14,
      issues: [
        {
          UnexpandedVariable: {
            suggested: "%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python312",
          },
        },
      ],
    },
    {
      id: "usr-2",
      raw_value: "C:\\Program Files\\nodejs\\",
      resolved_value: "C:\\Program Files\\nodejs\\",
      scope: "User",
      source_text: null,
      exists: true,
      executable_count: 6,
      issues: [{ Duplicate: { first_seen_index: 1 } }],
    },
    {
      id: "dot-0",
      raw_value: "$HOME/.cargo/bin",
      resolved_value: "/home/developer/.cargo/bin",
      source_text: "$HOME/.cargo/bin",
      scope: {
        Dotfile: {
          file_path: "/home/developer/.zshrc",
          line_number: 42,
        },
      },
      exists: true,
      executable_count: 18,
      issues: [
        {
          OrderRisk: {
            reason:
              "Your home folder is searched before the system folders (position #3), so a program placed here would run instead of the real system command.",
          },
        },
      ],
    },
    {
      id: "proc-0",
      raw_value: "/home/developer/.nvm/versions/node/v22.4.0/bin",
      resolved_value: "/home/developer/.nvm/versions/node/v22.4.0/bin",
      scope: "Process",
      source_text: null,
      exists: true,
      executable_count: 4,
      issues: [],
    },
    {
      id: "lnx-0",
      raw_value: "/usr/bin",
      resolved_value: "/usr/bin",
      scope: "System",
      source_text: null,
      exists: true,
      executable_count: 892,
      issues: [],
    },
    {
      id: "lnx-1",
      raw_value: "/bin",
      resolved_value: "/bin",
      scope: "System",
      source_text: null,
      exists: true,
      executable_count: 892,
      issues: [
        { AliasPath: { canonical: "/usr/bin", first_seen_index: 6 } },
      ],
    },
  ],
  conflicts: [
    {
      binary_name: "python",
      locations: [
        {
          full_path: "C:\\Program Files\\Python39\\python.exe",
          path_entry_index: 2,
          is_active: true,
          version_hint: "Python 3.9.13",
        },
        {
          full_path:
            "C:\\Users\\Developer\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
          path_entry_index: 4,
          is_active: false,
          version_hint: "Python 3.12.4",
        },
      ],
    },
    {
      binary_name: "node",
      locations: [
        {
          full_path: "C:\\Program Files\\nodejs\\node.exe",
          path_entry_index: 1,
          is_active: true,
          version_hint: "v20.11.0",
        },
        {
          full_path: "C:\\Users\\Developer\\.nvm\\v22.4.0\\node.exe",
          path_entry_index: 4,
          is_active: false,
          version_hint: "v22.4.0",
        },
      ],
    },
  ],
  variables: [
    {
      key: "JAVA_HOME",
      value: "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.2",
      is_expandable: false,
      scope: "System",
      is_modified: false,
    },
    {
      key: "OPENAI_API_KEY",
      value: "example-masked-api-key-placeholder",
      is_expandable: false,
      scope: "User",
      is_modified: false,
    },
    {
      key: "GOPATH",
      value: "%USERPROFILE%\\go",
      is_expandable: true,
      scope: "User",
      is_modified: false,
    },
    {
      key: "NVM_DIR",
      value: "$HOME/.nvm",
      is_expandable: true,
      scope: {
        Dotfile: {
          file_path: "/home/developer/.zshrc",
          line_number: 18,
        },
      },
      is_modified: false,
    },
  ],
};

export async function apiRunFullDiagnostics(
  probeVersions = true
): Promise<DiagnosticReport> {
  if (!isTauriRuntime()) {
    return structuredClone(FALLBACK_REPORT);
  }
  return invoke<DiagnosticReport>("run_full_diagnostics", {
    probeVersions,
  });
}

export async function apiReanalyzeStagedPaths(
  entries: PathEntry[],
  probeVersions = false
): Promise<[number, PathEntry[], BinaryConflict[]]> {
  if (!isTauriRuntime()) {
    return [88, entries, FALLBACK_REPORT.conflicts];
  }
  return invoke<[number, PathEntry[], BinaryConflict[]]>(
    "reanalyze_staged_paths",
    {
      entries,
      probeVersions,
    }
  );
}

export async function apiCleanAllPaths(
  entries: PathEntry[],
  shortenUnexpanded = true
): Promise<PathEntry[]> {
  if (!isTauriRuntime()) {
    return entries.filter(
      (e) =>
        e.exists &&
        !e.issues.some((i) => typeof i === "object" && "Duplicate" in i)
    );
  }
  return invoke<PathEntry[]>("clean_all_paths", {
    entries,
    shortenUnexpanded,
  });
}

export async function apiGetDirectoryExecutables(
  targetIndex: number,
  entries: PathEntry[],
  conflicts: BinaryConflict[]
): Promise<DirectoryExecutable[]> {
  if (!isTauriRuntime()) {
    return [
      {
        name: "python.exe",
        full_path:
          "C:\\Users\\Developer\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
        version_hint: "Python 3.12.4",
        is_shadowed: targetIndex === 4,
        active_path: "C:\\Program Files\\Python39\\python.exe",
      },
      {
        name: "pip.exe",
        full_path:
          "C:\\Users\\Developer\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\pip.exe",
        version_hint: "pip 24.2",
        is_shadowed: false,
        active_path: null,
      },
    ];
  }
  return invoke<DirectoryExecutable[]>("get_directory_executables", {
    targetIndex,
    entries,
    conflicts,
  });
}

export async function apiResolveNewPathEntry(
  rawValue: string,
  scope: Scope
): Promise<PathEntry> {
  if (!isTauriRuntime()) {
    return {
      id: `new-${Date.now()}`,
      raw_value: rawValue,
      resolved_value: rawValue,
      scope,
      source_text: null,
      exists: true,
      executable_count: 5,
      issues: [],
    };
  }
  return invoke<PathEntry>("resolve_new_path_entry", {
    rawValue,
    scope,
  });
}

export async function apiPreviewStagedDiff(
  stagedPaths: PathEntry[],
  stagedVars: EnvVariable[]
): Promise<SnapshotDiff> {
  if (!isTauriRuntime()) {
    return {
      snapshot_id: "staged-preview",
      snapshot_title: "Pre-Apply Staged Diff Preview",
      created_at: "Pending",
      unified_diff:
        "--- a/PATH\n+++ b/PATH\n@@ -1,5 +1,4 @@\n-[USR] C:\\Old_SDK\\bin\n+[USR] %USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python312",
      path_diffs: stagedPaths.map((p, i) => ({
        change_type: "unchanged",
        old_index: i + 1,
        new_index: i + 1,
        content: `[${p.scope === "System" ? "SYS" : "USR"}] ${p.raw_value}`,
        scope_label: p.scope === "System" ? "SYS" : "USR",
      })),
      var_diffs: [],
    };
  }
  return invoke<SnapshotDiff>("preview_staged_diff", {
    stagedPaths,
    stagedVars,
  });
}

export async function apiApplyStagedChanges(
  payload: ApplyChangesPayload
): Promise<ApplyChangesResult> {
  if (!isTauriRuntime()) {
    return {
      success: true,
      snapshot_id: `snap-${Date.now()}`,
      broadcasted: true,
      message: "Changes applied successfully (Browser Preview Mode).",
      warnings: [],
    };
  }
  return invoke<ApplyChangesResult>("apply_staged_changes", { payload });
}

export async function apiGetSnapshots(): Promise<Snapshot[]> {
  if (!isTauriRuntime()) {
    return [
      {
        id: "snap-initial",
        created_at: "2026-10-18 22:00:00",
        title: "Initial System Baseline",
        description:
          "Initial baseline snapshot recorded automatically when Env & PATH Doctor first launched.",
        is_automatic: true,
        path_count: FALLBACK_REPORT.path_entries.length,
        var_count: FALLBACK_REPORT.variables.length,
        path_entries: FALLBACK_REPORT.path_entries,
        variables: FALLBACK_REPORT.variables,
      },
    ];
  }
  return invoke<Snapshot[]>("get_snapshots");
}

export async function apiCreateManualSnapshot(
  title: string,
  description: string
): Promise<Snapshot> {
  if (!isTauriRuntime()) {
    return {
      id: `snap-${Date.now()}`,
      created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      title,
      description,
      is_automatic: false,
      path_count: FALLBACK_REPORT.path_entries.length,
      var_count: FALLBACK_REPORT.variables.length,
      path_entries: FALLBACK_REPORT.path_entries,
      variables: FALLBACK_REPORT.variables,
    };
  }
  return invoke<Snapshot>("create_manual_snapshot", { title, description });
}

export async function apiDeleteSnapshot(snapshotId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("delete_snapshot_cmd", { snapshotId });
}

export async function apiGetSnapshotDiff(
  snapshotId: string,
  currentPaths: PathEntry[],
  currentVars: EnvVariable[]
): Promise<SnapshotDiff> {
  if (!isTauriRuntime()) {
    return apiPreviewStagedDiff(currentPaths, currentVars);
  }
  return invoke<SnapshotDiff>("get_snapshot_diff", {
    snapshotId,
    currentPaths,
    currentVars,
  });
}

export async function apiRestoreSnapshot(
  snapshotId: string,
  allowUacElevation = true
): Promise<ApplyChangesResult> {
  if (!isTauriRuntime()) {
    return {
      success: true,
      snapshot_id: snapshotId,
      broadcasted: true,
      message: "Restored to selected snapshot.",
      warnings: [],
    };
  }
  return invoke<ApplyChangesResult>("restore_snapshot", {
    snapshotId,
    allowUacElevation,
  });
}

export async function apiGetProfiles(): Promise<EnvironmentProfile[]> {
  if (!isTauriRuntime()) {
    return [
      {
        id: "prof-java21",
        name: "Java 21 & Spring Boot Environment",
        description: "Switches JAVA_HOME to OpenJDK 21 and enables Maven/Gradle paths.",
        created_at: "2026-10-18 21:30:00",
        variables: FALLBACK_REPORT.variables,
        path_entries: FALLBACK_REPORT.path_entries,
      },
    ];
  }
  return invoke<EnvironmentProfile[]>("get_profiles");
}

export async function apiSaveProfile(
  name: string,
  description: string,
  variables: EnvVariable[],
  pathEntries: PathEntry[]
): Promise<EnvironmentProfile> {
  if (!isTauriRuntime()) {
    return {
      id: `prof-${Date.now()}`,
      name,
      description,
      created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      variables,
      path_entries: pathEntries,
    };
  }
  return invoke<EnvironmentProfile>("save_profile_cmd", {
    name,
    description,
    variables,
    pathEntries,
  });
}

export async function apiDeleteProfile(profileId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("delete_profile_cmd", { profileId });
}

export async function apiExportEnvironment(
  format: "json" | "dotenv",
  pathEntries: PathEntry[],
  variables: EnvVariable[]
): Promise<string> {
  if (!isTauriRuntime()) {
    if (format === "dotenv") {
      return `PATH="${pathEntries.map((p) => p.raw_value).join(";")}"\n`;
    }
    return JSON.stringify({ path_entries: pathEntries, variables }, null, 2);
  }
  return invoke<string>("export_environment", {
    format,
    pathEntries,
    variables,
  });
}

/**
 * Write already-rendered export text to a user-chosen path.
 *
 * Content is produced on the frontend so the exported wording stays identical
 * to what the UI shows; the backend only performs the write.
 */
export async function apiSaveExportFile(
  path: string,
  contents: string
): Promise<ExportFileOutcome> {
  if (!isTauriRuntime()) {
    return { path, bytes: new Blob([contents]).size };
  }
  return invoke<ExportFileOutcome>("save_export_file", { path, contents });
}
