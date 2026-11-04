use crate::core::doctor::{analyze_path_entries, expand_path_variables};
use crate::core::scanner::scan_directory_executables;
use crate::core::snapshot::{compute_state_diff, create_snapshot};
use crate::core::{
    would_erase_environment, ApplyChangesPayload, ApplyChangesResult, EnvVariable, PathEntry,
    Scope, SnapshotDiff,
};
use crate::platform::get_platform_manager;
use std::collections::HashMap;
use uuid::Uuid;

#[tauri::command]
pub fn resolve_new_path_entry(raw_value: String, scope: Scope) -> Result<PathEntry, String> {
    let mut env_lookup: HashMap<String, String> = HashMap::new();
    for (k, v) in crate::core::unicode_env_vars() {
        // Keep the exact spelling on Unix (names are case-sensitive); Windows
        // callers still resolve a differently-cased spelling through the
        // upper-case fallback inside `expand_path_variables`.
        env_lookup.insert(k, v);
    }

    let trimmed = raw_value.trim().to_string();
    if trimmed.is_empty() {
        return Err("Path cannot be empty.".to_string());
    }

    let resolved = expand_path_variables(&trimmed, &env_lookup);
    let exists = resolved.exists() && resolved.is_dir();
    let executable_count = if exists {
        scan_directory_executables(&resolved).len()
    } else {
        0
    };

    let mut entries = vec![PathEntry {
        id: format!("new-{}", Uuid::new_v4()),
        raw_value: trimmed,
        resolved_value: resolved,
        scope,
        source_text: None,
        exists,
        executable_count,
        issues: Vec::new(),
    }];
    analyze_path_entries(&mut entries);
    Ok(entries.remove(0))
}

#[tauri::command]
pub fn preview_staged_diff(
    staged_paths: Vec<PathEntry>,
    staged_vars: Vec<EnvVariable>,
) -> Result<SnapshotDiff, String> {
    let manager = get_platform_manager();
    let (current_paths, current_vars, _) = manager.load_environment()?;

    Ok(compute_state_diff(
        "staged-preview",
        "Pre-Apply Staged Diff Preview",
        "Pending",
        &current_paths,
        &current_vars,
        &staged_paths,
        &staged_vars,
    ))
}

#[tauri::command]
pub fn apply_staged_changes(payload: ApplyChangesPayload) -> Result<ApplyChangesResult, String> {
    let manager = get_platform_manager();
    let (current_paths, current_vars, _) = manager.load_environment()?;

    // An empty payload means the UI never loaded the environment (a failed scan
    // leaves both lists empty). Applying it would delete every PATH entry and
    // every variable from the machine, so refuse while the current state is
    // known to be non-empty.
    if would_erase_environment(
        &current_paths,
        &current_vars,
        &payload.path_entries,
        &payload.variables,
    ) {
        return Err(
            "Refusing to apply an empty configuration: the current environment was not loaded. Rescan and try again."
                .to_string(),
        );
    }

    // Section 4.3: Always create an automatic snapshot right before applying changes
    let snap_title = payload
        .snapshot_title
        .unwrap_or_else(|| "Automatic Backup Before Apply".to_string());
    let snap = create_snapshot(
        &snap_title,
        "Automatic protective snapshot created right before applying PATH and environment variable changes.",
        true,
        &current_paths,
        &current_vars,
    )?;

    let (broadcasted, warnings) = manager.apply_environment(
        &payload.path_entries,
        &payload.variables,
        payload.allow_uac_elevation,
    )?;

    Ok(ApplyChangesResult {
        success: true,
        snapshot_id: snap.id,
        broadcasted,
        message: "Environment variable and PATH changes have been safely applied.".to_string(),
        warnings,
    })
}
