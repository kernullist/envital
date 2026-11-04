use crate::core::{
    DiffLine, EnvVariable, EnvironmentProfile, PathEntry, Scope, Snapshot, SnapshotDiff, VarDiff,
};
use chrono::Local;
use rusqlite::{params, Connection};
use similar::{ChangeTag, TextDiff};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

pub fn get_app_data_dir() -> PathBuf {
    let base = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("env-doctor");
    let _ = fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    dir
}

pub fn get_db_path() -> PathBuf {
    get_app_data_dir().join("snapshots.db")
}

pub fn open_db() -> Result<Connection, String> {
    let db_path = get_db_path();
    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open SQLite DB: {}", e))?;
    init_schema(&conn)?;
    // The database stores environment variable values so a snapshot can restore
    // them; keep it readable by the owning account only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&db_path, fs::Permissions::from_mode(0o600));
    }
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS snapshots (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            is_automatic INTEGER NOT NULL DEFAULT 0,
            path_entries_json TEXT NOT NULL,
            variables_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            created_at TEXT NOT NULL,
            variables_json TEXT NOT NULL,
            path_entries_json TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| format!("Failed to initialize DB schema: {}", e))?;

    Ok(())
}

pub fn scope_label(scope: &Scope) -> String {
    match scope {
        Scope::User => "USR".to_string(),
        Scope::System => "SYS".to_string(),
        Scope::Process => "PROC".to_string(),
        Scope::Dotfile {
            file_path,
            line_number,
            ..
        } => {
            let name = file_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_path.to_string_lossy().to_string());
            format!("{}:{}", name, line_number)
        }
    }
}

pub fn create_snapshot(
    title: &str,
    description: &str,
    is_automatic: bool,
    path_entries: &[PathEntry],
    variables: &[EnvVariable],
) -> Result<Snapshot, String> {
    let conn = open_db()?;
    let id = Uuid::new_v4().to_string();
    let created_at = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let path_json = serde_json::to_string(path_entries)
        .map_err(|e| format!("Failed to serialize PATH entries: {}", e))?;
    // Session-only variables are a view of the running process. They are never
    // written back by `apply_environment` and are skipped by the diff engine, so
    // storing them would only copy unrelated secrets (tokens, API keys) into a
    // plain SQLite file.
    let stored_variables: Vec<EnvVariable> = variables
        .iter()
        .filter(|var| var.scope != Scope::Process)
        .cloned()
        .collect();
    let var_json = serde_json::to_string(&stored_variables)
        .map_err(|e| format!("Failed to serialize environment variables: {}", e))?;

    conn.execute(
        "INSERT INTO snapshots (id, created_at, title, description, is_automatic, path_entries_json, variables_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            created_at,
            title,
            description,
            if is_automatic { 1 } else { 0 },
            path_json,
            var_json
        ],
    )
    .map_err(|e| format!("Failed to insert snapshot: {}", e))?;

    Ok(Snapshot {
        id,
        created_at,
        title: title.to_string(),
        description: description.to_string(),
        is_automatic,
        path_count: path_entries.len(),
        var_count: stored_variables.len(),
        path_entries: path_entries.to_vec(),
        variables: stored_variables,
    })
}

pub fn list_snapshots() -> Result<Vec<Snapshot>, String> {
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at, title, description, is_automatic, path_entries_json, variables_json
             FROM snapshots
             ORDER BY created_at DESC, rowid DESC
             LIMIT 100",
        )
        .map_err(|e| format!("Failed to query snapshots: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let created_at: String = row.get(1)?;
            let title: String = row.get(2)?;
            let description: String = row.get(3)?;
            let is_auto_int: i32 = row.get(4)?;
            let path_json: String = row.get(5)?;
            let var_json: String = row.get(6)?;

            let path_entries: Vec<PathEntry> =
                serde_json::from_str(&path_json).unwrap_or_default();
            let variables: Vec<EnvVariable> = serde_json::from_str(&var_json).unwrap_or_default();

            Ok(Snapshot {
                id,
                created_at,
                title,
                description,
                is_automatic: is_auto_int != 0,
                path_count: path_entries.len(),
                var_count: variables.len(),
                path_entries,
                variables,
            })
        })
        .map_err(|e| format!("Failed to map snapshots: {}", e))?;

    let mut out = Vec::new();
    for r in rows {
        if let Ok(snap) = r {
            out.push(snap);
        }
    }
    Ok(out)
}

pub fn get_snapshot_by_id(snapshot_id: &str) -> Result<Snapshot, String> {
    let conn = open_db()?;
    conn.query_row(
        "SELECT id, created_at, title, description, is_automatic, path_entries_json, variables_json
         FROM snapshots WHERE id = ?1",
        params![snapshot_id],
        |row| {
            let id: String = row.get(0)?;
            let created_at: String = row.get(1)?;
            let title: String = row.get(2)?;
            let description: String = row.get(3)?;
            let is_auto_int: i32 = row.get(4)?;
            let path_json: String = row.get(5)?;
            let var_json: String = row.get(6)?;

            let path_entries: Vec<PathEntry> =
                serde_json::from_str(&path_json).unwrap_or_default();
            let variables: Vec<EnvVariable> = serde_json::from_str(&var_json).unwrap_or_default();

            Ok(Snapshot {
                id,
                created_at,
                title,
                description,
                is_automatic: is_auto_int != 0,
                path_count: path_entries.len(),
                var_count: variables.len(),
                path_entries,
                variables,
            })
        },
    )
    .map_err(|e| format!("Snapshot ({}) not found: {}", snapshot_id, e))
}

pub fn delete_snapshot(snapshot_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute("DELETE FROM snapshots WHERE id = ?1", params![snapshot_id])
        .map_err(|e| format!("Failed to delete snapshot: {}", e))?;
    Ok(())
}

/// Compute Git-style diff and structured PATH / Variable diff between `old` (e.g., Snapshot or Current)
/// and `new` (e.g., Current or Staged) using the `similar` crate.
pub fn compute_state_diff(
    id: &str,
    title: &str,
    created_at: &str,
    old_paths: &[PathEntry],
    old_vars: &[EnvVariable],
    new_paths: &[PathEntry],
    new_vars: &[EnvVariable],
) -> SnapshotDiff {
    let old_path_lines: String = old_paths
        .iter()
        .map(|p| format!("[{}] {}", scope_label(&p.scope), p.raw_value))
        .collect::<Vec<_>>()
        .join("\n");

    let new_path_lines: String = new_paths
        .iter()
        .map(|p| format!("[{}] {}", scope_label(&p.scope), p.raw_value))
        .collect::<Vec<_>>()
        .join("\n");

    let text_diff = TextDiff::from_lines(&old_path_lines, &new_path_lines);
    let mut path_diffs = Vec::new();

    for change in text_diff.iter_all_changes() {
        let change_type = match change.tag() {
            ChangeTag::Delete => "removed",
            ChangeTag::Insert => "added",
            ChangeTag::Equal => "unchanged",
        };
        let line_str = change.value().trim_end_matches(&['\r', '\n'][..]).to_string();
        if line_str.is_empty() && old_paths.is_empty() && new_paths.is_empty() {
            continue;
        }
        let scope_lbl = line_str
            .strip_prefix('[')
            // A PATH value is allowed to contain a line break on Unix. The
            // continuation line has no `[label] ` prefix, so it must not be
            // sliced with an index that can point before the start of the line.
            .and_then(|rest| rest.find(']').map(|end| rest[..end].to_string()))
            .unwrap_or_else(|| "USR".to_string());
        path_diffs.push(DiffLine {
            change_type: change_type.to_string(),
            old_index: change.old_index().map(|i| i + 1),
            new_index: change.new_index().map(|i| i + 1),
            content: line_str,
            scope_label: scope_lbl,
        });
    }

    // Compute Variable diffs
    let mut old_var_map: HashMap<(String, String), &EnvVariable> = HashMap::new();
    for v in old_vars {
        if v.scope == Scope::Process {
            continue;
        }
        old_var_map.insert((scope_label(&v.scope), v.key.clone()), v);
    }

    let mut new_var_map: HashMap<(String, String), &EnvVariable> = HashMap::new();
    for v in new_vars {
        if v.scope == Scope::Process {
            continue;
        }
        new_var_map.insert((scope_label(&v.scope), v.key.clone()), v);
    }

    let mut var_diffs = Vec::new();
    for ((scope_lbl, key), old_v) in &old_var_map {
        match new_var_map.get(&(scope_lbl.clone(), key.clone())) {
            None => {
                var_diffs.push(VarDiff {
                    key: key.clone(),
                    change_type: "removed".to_string(),
                    old_value: Some(old_v.value.clone()),
                    new_value: None,
                    scope_label: scope_lbl.clone(),
                });
            }
            Some(new_v)
                // A REG_SZ/REG_EXPAND_SZ (or env.sh expandable) toggle changes
                // what Apply writes even when the text is identical.
                if new_v.value != old_v.value
                    || new_v.is_expandable != old_v.is_expandable =>
            {
                var_diffs.push(VarDiff {
                    key: key.clone(),
                    change_type: "modified".to_string(),
                    old_value: Some(old_v.value.clone()),
                    new_value: Some(new_v.value.clone()),
                    scope_label: scope_lbl.clone(),
                });
            }
            _ => {}
        }
    }

    for ((scope_lbl, key), new_v) in &new_var_map {
        if !old_var_map.contains_key(&(scope_lbl.clone(), key.clone())) {
            var_diffs.push(VarDiff {
                key: key.clone(),
                change_type: "added".to_string(),
                old_value: None,
                new_value: Some(new_v.value.clone()),
                scope_label: scope_lbl.clone(),
            });
        }
    }

    var_diffs.sort_by(|a, b| {
        a.key
            .cmp(&b.key)
            .then_with(|| a.scope_label.cmp(&b.scope_label))
    });

    let unified_diff = text_diff
        .unified_diff()
        .context_radius(3)
        .header("a/PATH (Snapshot)", "b/PATH (Target)")
        .to_string();

    SnapshotDiff {
        snapshot_id: id.to_string(),
        snapshot_title: title.to_string(),
        created_at: created_at.to_string(),
        unified_diff,
        path_diffs,
        var_diffs,
    }
}

/// List or initialize Environment Profiles (Phase 3 feature)
pub fn list_profiles() -> Result<Vec<EnvironmentProfile>, String> {
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, created_at, variables_json, path_entries_json
             FROM profiles
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to query profiles: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let description: String = row.get(2)?;
            let created_at: String = row.get(3)?;
            let var_json: String = row.get(4)?;
            let path_json: String = row.get(5)?;

            let variables: Vec<EnvVariable> = serde_json::from_str(&var_json).unwrap_or_default();
            let path_entries: Vec<PathEntry> =
                serde_json::from_str(&path_json).unwrap_or_default();

            Ok(EnvironmentProfile {
                id,
                name,
                description,
                created_at,
                variables,
                path_entries,
            })
        })
        .map_err(|e| format!("Failed to map profiles: {}", e))?;

    let mut out = Vec::new();
    for r in rows {
        if let Ok(p) = r {
            out.push(p);
        }
    }
    Ok(out)
}

pub fn save_profile(
    name: &str,
    description: &str,
    variables: &[EnvVariable],
    path_entries: &[PathEntry],
) -> Result<EnvironmentProfile, String> {
    let conn = open_db()?;
    let id = Uuid::new_v4().to_string();
    let created_at = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    // Filter out runtime session variables (`Scope::Process`) so transient
    // session secrets (tokens, API keys) are never persisted into SQLite profiles.
    let stored_variables: Vec<EnvVariable> = variables
        .iter()
        .filter(|var| var.scope != Scope::Process)
        .cloned()
        .collect();
    let var_json = serde_json::to_string(&stored_variables)
        .map_err(|e| format!("Failed to serialize variables: {}", e))?;
    let path_json = serde_json::to_string(path_entries)
        .map_err(|e| format!("Failed to serialize PATH entries: {}", e))?;

    conn.execute(
        "INSERT INTO profiles (id, name, description, created_at, variables_json, path_entries_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, description, created_at, var_json, path_json],
    )
    .map_err(|e| format!("Failed to save profile: {}", e))?;

    Ok(EnvironmentProfile {
        id,
        name: name.to_string(),
        description: description.to_string(),
        created_at,
        variables: stored_variables,
        path_entries: path_entries.to_vec(),
    })
}

pub fn delete_profile(profile_id: &str) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute("DELETE FROM profiles WHERE id = ?1", params![profile_id])
        .map_err(|e| format!("Failed to delete profile: {}", e))?;
    Ok(())
}

/// Escape one value for a double-quoted `.env` assignment.
///
/// Dotenv parsers interpret backslash escapes inside double quotes, so the
/// literal Windows path `C:\nodejs` would otherwise be read as `C:` followed by
/// a newline (`\n`) and `C:\temp` as a tab (`\t`). Escaping every backslash
/// keeps the path literal, and a real line break is written in its escaped
/// `\n`/`\r` form so the file stays one assignment per line.
fn dotenv_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out
}

/// Whether a key can be written as a `.env` assignment.
///
/// Registry value names are almost unrestricted (they may contain spaces, `=`,
/// dots or a line break), and writing one verbatim would produce a broken or
/// injected line in the exported file.
fn is_dotenv_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Format variables and PATH as `.env` content for export (Section 4.3)
pub fn export_as_dotenv(path_entries: &[PathEntry], variables: &[EnvVariable]) -> String {
    let mut lines = Vec::new();
    lines.push("# Generated by Env & PATH Doctor".to_string());
    lines.push(format!(
        "# Exported at {}",
        Local::now().format("%Y-%m-%d %H:%M:%S")
    ));
    lines.push(String::new());

    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
    let joined_path = path_entries
        .iter()
        .map(|p| p.raw_value.as_str())
        .collect::<Vec<_>>()
        .join(sep);
    lines.push(format!("PATH=\"{}\"", dotenv_escape(&joined_path)));
    lines.push(String::new());

    let mut skipped_keys = 0usize;
    for var in variables {
        if var.scope == Scope::Process || var.key.eq_ignore_ascii_case("PATH") {
            continue;
        }
        if !is_dotenv_key(&var.key) {
            skipped_keys += 1;
            continue;
        }
        lines.push(format!("{}=\"{}\"", var.key, dotenv_escape(&var.value)));
    }
    if skipped_keys > 0 {
        lines.push(format!(
            "# {} variable(s) with a name that is not valid in a .env file were skipped.",
            skipped_keys
        ));
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_compute_state_diff() {
        let old_paths = vec![PathEntry {
            id: "1".into(),
            raw_value: "C:\\OldPath".into(),
            resolved_value: PathBuf::from("C:\\OldPath"),
            scope: Scope::User,
            source_text: None,
            exists: true,
            executable_count: 1,
            issues: vec![],
        }];
        let new_paths = vec![PathEntry {
            id: "2".into(),
            raw_value: "C:\\NewPath".into(),
            resolved_value: PathBuf::from("C:\\NewPath"),
            scope: Scope::User,
            source_text: None,
            exists: true,
            executable_count: 2,
            issues: vec![],
        }];
        let diff = compute_state_diff("test", "Test Diff", "now", &old_paths, &[], &new_paths, &[]);
        assert!(diff.unified_diff.contains("C:\\OldPath"));
        assert!(diff.unified_diff.contains("C:\\NewPath"));
        assert_eq!(diff.path_diffs.len(), 2);
    }

    #[test]
    fn dotenv_export_escapes_values_and_skips_invalid_keys() {
        // A dotenv parser interprets backslash escapes inside double quotes, so
        // `C:\nodejs` (which contains `\n`) and `C:\temp` (`\t`) only survive if
        // every backslash is escaped. A variable name that cannot be written as
        // `KEY=value` (it came from an unrestricted registry name) must not
        // produce a broken or injected line.
        let paths = vec![PathEntry {
            id: "1".into(),
            raw_value: "C:\\nodejs".into(),
            resolved_value: PathBuf::from("C:\\nodejs"),
            scope: Scope::System,
            source_text: None,
            exists: true,
            executable_count: 2,
            issues: vec![],
        }];
        let variables = vec![
            EnvVariable {
                key: "OK".into(),
                value: "C:\\temp\\a\"b\nc".into(),
                is_expandable: false,
                scope: Scope::User,
                is_modified: false,
            },
            EnvVariable {
                key: "EMPTY".into(),
                value: String::new(),
                is_expandable: false,
                scope: Scope::User,
                is_modified: false,
            },
            EnvVariable {
                key: "BAD KEY".into(),
                value: "x".into(),
                is_expandable: false,
                scope: Scope::User,
                is_modified: false,
            },
        ];

        let text = export_as_dotenv(&paths, &variables);

        assert!(
            text.contains(r#"PATH="C:\\nodejs""#),
            "a literal backslash must be doubled: {text}"
        );
        assert!(
            text.contains(r#"OK="C:\\temp\\a\"b\nc""#),
            "quotes and line breaks must stay inside one escaped assignment: {text}"
        );
        assert!(text.contains(r#"EMPTY="""#), "an empty value is still written");
        assert!(
            !text.contains("BAD KEY"),
            "an invalid key must not reach the file: {text}"
        );
        assert!(
            text.contains("not valid in a .env file"),
            "the skipped key must be accounted for: {text}"
        );
    }
}
