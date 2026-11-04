use crate::core::doctor::{
    analyze_path_entries, calculate_health_score, clean_path_entries, expand_path_variables,
    is_protected_system_path,
};
use crate::core::scanner::{inspect_directory_executables, scan_path_and_conflicts};
use crate::core::{
    BinaryConflict, DiagnosticIssue, DiagnosticReport, DirectoryExecutable, PathEntry, Scope,
};
use crate::platform::get_platform_manager;
use std::path::Path;

#[tauri::command]
pub fn run_full_diagnostics(probe_versions: bool) -> Result<DiagnosticReport, String> {
    let manager = get_platform_manager();
    let (mut path_entries, variables, mut os_context) = manager.load_environment()?;

    let conflicts = scan_path_and_conflicts(&mut path_entries, probe_versions);
    analyze_path_entries(&mut path_entries);

    let mut dead_count = 0;
    let mut duplicate_count = 0;
    let mut alias_count = 0;
    let mut empty_count = 0;
    let mut unexpanded_count = 0;
    let mut security_count = 0;
    let mut order_count = 0;

    for entry in &path_entries {
        for issue in &entry.issues {
            match issue {
                DiagnosticIssue::DeadPath => dead_count += 1,
                DiagnosticIssue::Duplicate { .. } => duplicate_count += 1,
                DiagnosticIssue::AliasPath { .. } => alias_count += 1,
                DiagnosticIssue::EmptyDirectory => empty_count += 1,
                DiagnosticIssue::UnexpandedVariable { .. } => unexpanded_count += 1,
                DiagnosticIssue::SecurityRisk { .. } => security_count += 1,
                DiagnosticIssue::OrderRisk { .. } => order_count += 1,
            }
        }
    }

    // PATH entries that no readable config file declares: tool-manager / package
    // manager injections. Reported separately and excluded from the score.
    let session_count = path_entries
        .iter()
        .filter(|p| p.scope == Scope::Process)
        .count();

    let conflict_count = conflicts.len();
    let score = calculate_health_score(&path_entries, conflict_count);
    os_context.total_path_length = path_entries.iter().map(|p| p.raw_value.len() + 1).sum();

    Ok(DiagnosticReport {
        score,
        dead_count,
        duplicate_count,
        alias_count,
        empty_count,
        unexpanded_count,
        security_count,
        order_count,
        session_count,
        conflict_count,
        path_entries,
        conflicts,
        variables,
        os_context,
    })
}

#[tauri::command]
pub fn reanalyze_staged_paths(
    mut entries: Vec<PathEntry>,
    probe_versions: bool,
) -> Result<(u8, Vec<PathEntry>, Vec<BinaryConflict>), String> {
    // `raw_value` is what Apply writes, so it is the source of truth. A JSON
    // export imported from another machine carries the old machine's
    // `resolved_value`; rebuilding it here keeps the existence, empty-folder and
    // conflict checks honest on this machine.
    let env_lookup: std::collections::HashMap<String, String> =
        crate::core::unicode_env_vars().into_iter().collect();
    for entry in &mut entries {
        entry.resolved_value = expand_path_variables(&entry.raw_value, &env_lookup);
    }
    let conflicts = scan_path_and_conflicts(&mut entries, probe_versions);
    analyze_path_entries(&mut entries);
    let score = calculate_health_score(&entries, conflicts.len());
    Ok((score, entries, conflicts))
}

#[tauri::command]
pub fn clean_all_paths(
    entries: Vec<PathEntry>,
    shorten_unexpanded: bool,
) -> Result<Vec<PathEntry>, String> {
    Ok(clean_path_entries(&entries, shorten_unexpanded))
}

#[tauri::command]
pub fn get_directory_executables(
    target_index: usize,
    entries: Vec<PathEntry>,
    conflicts: Vec<BinaryConflict>,
) -> Result<Vec<DirectoryExecutable>, String> {
    Ok(inspect_directory_executables(
        target_index,
        &entries,
        &conflicts,
    ))
}

#[tauri::command]
pub fn check_protected_path(raw_value: String, resolved_value: String) -> bool {
    is_protected_system_path(&raw_value, Path::new(&resolved_value))
}
