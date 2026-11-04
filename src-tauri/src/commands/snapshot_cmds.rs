use crate::core::snapshot::{
    compute_state_diff, create_snapshot, delete_profile, delete_snapshot, export_as_dotenv,
    get_snapshot_by_id, list_profiles, list_snapshots, save_profile,
};
use crate::core::{
    would_erase_environment, ApplyChangesResult, EnvVariable, EnvironmentProfile, PathEntry,
    Snapshot, SnapshotDiff,
};
use crate::platform::get_platform_manager;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct JsonExportBundle {
    pub exported_at: String,
    pub path_entries: Vec<PathEntry>,
    pub variables: Vec<EnvVariable>,
}

#[tauri::command]
pub fn get_snapshots() -> Result<Vec<Snapshot>, String> {
    let mut snaps = list_snapshots()?;
    // If no snapshots exist yet, create an initial baseline snapshot so Time Machine is immediately useful
    if snaps.is_empty() {
        let manager = get_platform_manager();
        if let Ok((paths, vars, _)) = manager.load_environment() {
            if let Ok(initial) = create_snapshot(
                "Initial System Baseline",
                "Initial baseline snapshot recorded automatically when Env & PATH Doctor first launched.",
                true,
                &paths,
                &vars,
            ) {
                snaps.push(initial);
            }
        }
    }
    Ok(snaps)
}

#[tauri::command]
pub fn create_manual_snapshot(title: String, description: String) -> Result<Snapshot, String> {
    let clean_title = if title.trim().is_empty() {
        "Manual Snapshot".to_string()
    } else {
        title.trim().to_string()
    };
    // A Time-Machine snapshot is a backup of the machine, not of the edit form.
    // Read the live environment here instead of storing the staged lists the
    // frontend holds: restoring a snapshot that contained never-applied edits
    // would install a configuration that never existed on this machine.
    let manager = get_platform_manager();
    let (paths, vars, _) = manager.load_environment()?;
    create_snapshot(&clean_title, description.trim(), false, &paths, &vars)
}

#[tauri::command]
pub fn delete_snapshot_cmd(snapshot_id: String) -> Result<(), String> {
    delete_snapshot(&snapshot_id)
}

#[tauri::command]
pub fn get_snapshot_diff(
    snapshot_id: String,
    current_paths: Vec<PathEntry>,
    current_vars: Vec<EnvVariable>,
) -> Result<SnapshotDiff, String> {
    let snap = get_snapshot_by_id(&snapshot_id)?;
    Ok(compute_state_diff(
        &snap.id,
        &snap.title,
        &snap.created_at,
        &snap.path_entries,
        &snap.variables,
        &current_paths,
        &current_vars,
    ))
}

#[tauri::command]
pub fn restore_snapshot(
    snapshot_id: String,
    allow_uac_elevation: bool,
) -> Result<ApplyChangesResult, String> {
    let target_snap = get_snapshot_by_id(&snapshot_id)?;
    let manager = get_platform_manager();
    let (current_paths, current_vars, _) = manager.load_environment()?;

    // A snapshot row that describes neither a PATH nor a variable (a corrupt
    // row, or one created while the environment could not be read) would wipe
    // the live configuration on restore just like an empty Apply payload.
    if would_erase_environment(
        &current_paths,
        &current_vars,
        &target_snap.path_entries,
        &target_snap.variables,
    ) {
        return Err(
            "Refusing to restore an empty snapshot: it contains no PATH entries and no variables, so applying it would delete the current environment."
                .to_string(),
        );
    }

    // Save a safety snapshot before rolling back
    let pre_restore_snap = create_snapshot(
        &format!("Pre-Rollback Backup (→ {})", target_snap.title),
        "Automatic backup created to preserve the current state right before restoring a snapshot.",
        true,
        &current_paths,
        &current_vars,
    )?;

    let (broadcasted, warnings) = manager.apply_environment(
        &target_snap.path_entries,
        &target_snap.variables,
        allow_uac_elevation,
    )?;

    Ok(ApplyChangesResult {
        success: true,
        snapshot_id: pre_restore_snap.id,
        broadcasted,
        message: format!("Restored to snapshot '{}' in 1 second.", target_snap.title),
        warnings,
    })
}

#[tauri::command]
pub fn get_profiles() -> Result<Vec<EnvironmentProfile>, String> {
    list_profiles()
}

#[tauri::command]
pub fn save_profile_cmd(
    name: String,
    description: String,
    variables: Vec<EnvVariable>,
    path_entries: Vec<PathEntry>,
) -> Result<EnvironmentProfile, String> {
    save_profile(&name, &description, &variables, &path_entries)
}

#[tauri::command]
pub fn delete_profile_cmd(profile_id: String) -> Result<(), String> {
    delete_profile(&profile_id)
}

#[tauri::command]
pub fn export_environment(
    format: String,
    path_entries: Vec<PathEntry>,
    variables: Vec<EnvVariable>,
) -> Result<String, String> {
    // Session variables cannot be restored by an import and may hold unrelated
    // secrets (tokens, API keys). The dotenv writer already skips them; filter
    // them here too so the JSON export is consistent and leaks no more than it
    // can actually restore.
    let restorable_variables: Vec<EnvVariable> = variables
        .into_iter()
        .filter(|var| var.scope != crate::core::Scope::Process)
        .collect();

    if format.eq_ignore_ascii_case("dotenv") || format.eq_ignore_ascii_case("env") {
        Ok(export_as_dotenv(&path_entries, &restorable_variables))
    } else {
        let bundle = JsonExportBundle {
            exported_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            path_entries,
            variables: restorable_variables,
        };
        serde_json::to_string_pretty(&bundle)
            .map_err(|e| format!("JSON export serialization error: {}", e))
    }
}
