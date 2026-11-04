pub mod doctor;
pub mod scanner;
pub mod snapshot;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The process environment as UTF-8 pairs, skipping entries that are not valid
/// Unicode.
///
/// `std::env::vars()` *panics* on a non-UTF-8 key or value. Environment
/// variables are arbitrary bytes on Unix, so one tool setting a non-UTF-8 value
/// would abort the whole scan. Such a variable can only affect expansion of a
/// template that references it, which is not worth crashing over.
pub fn unicode_env_vars() -> Vec<(String, String)> {
    std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Scope {
    User,
    System,
    /// Contributed by the process/session rather than declared in a configuration
    /// file. A `PATH` entry with this scope (a tool manager prepending a directory,
    /// `npm` injecting `node_modules/.bin`, a login shell exporting a path) is *not*
    /// something the user wrote down, so no fix is suggested and it never lowers
    /// the health score.
    Process,
    Dotfile {
        file_path: PathBuf,
        line_number: usize,
        /// `true` when this entry comes from a shell-redirecting declaration
        /// (`PATH="$HOME/x:$PATH"`), so `raw_value` holds the *expanded*
        /// directory rather than the text written in the file. Apply then has to
        /// write it as data: the text would not expand the same way under the
        /// POSIX shell that reads `env.sh`. Omitted by single-quoted, unquoted
        /// and Windows declarations, whose text is already literal.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        expanded: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DiagnosticIssue {
    DeadPath,
    /// The identical path text is registered more than once (after slash / case
    /// normalization). Actionable: the redundant entry can be merged away.
    Duplicate { first_seen_index: usize },
    /// Informational only: this entry reaches the same *physical* directory as an
    /// earlier entry through a symlink (`/bin` -> `/usr/bin` on merged-`/usr`
    /// distributions). Distinct from `Duplicate`: the path text differs and it is
    /// usually a distribution default. Never penalised by the health score and
    /// never merged automatically, so the default `PATH` is preserved.
    AliasPath {
        canonical: String,
        first_seen_index: usize,
    },
    EmptyDirectory,
    UnexpandedVariable { suggested: String },
    /// A folder that every account on the machine can write to (world-writable
    /// without the sticky bit). Real exposure: any user could drop a program here
    /// that then runs instead of the real command.
    SecurityRisk { reason: String },
    /// A user-writable folder that is searched *before* the system folders, so a
    /// local file could shadow a real command. Hardening advice only: prepending
    /// `~/.cargo/bin` or `~/.nvm/...` is the documented way to set up rustup/nvm, so
    /// this issue costs no health score.
    OrderRisk { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PathEntry {
    pub id: String,
    pub raw_value: String,
    pub resolved_value: PathBuf,
    pub scope: Scope,
    /// The entry exactly as written in the configuration file it was declared in
    /// (for example `$HOME/.cargo/bin`). `None` when the entry is not declared in
    /// any readable config file — see [`Scope::Process`](crate::core::Scope).
    #[serde(default)]
    pub source_text: Option<String>,
    pub exists: bool,
    pub executable_count: usize,
    pub issues: Vec<DiagnosticIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinaryConflict {
    pub binary_name: String,
    pub locations: Vec<BinaryInstance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinaryInstance {
    pub full_path: PathBuf,
    pub path_entry_index: usize,
    pub is_active: bool,
    pub version_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvVariable {
    pub key: String,
    pub value: String,
    pub is_expandable: bool,
    pub scope: Scope,
    pub is_modified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryExecutable {
    pub name: String,
    pub full_path: PathBuf,
    pub version_hint: Option<String>,
    pub is_shadowed: bool,
    pub active_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsContext {
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub total_path_length: usize,
    pub max_path_length: usize,
    pub is_elevated: bool,
    pub shell: String,
    pub home_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticReport {
    pub score: u8,
    pub dead_count: usize,
    pub duplicate_count: usize,
    pub alias_count: usize,
    pub empty_count: usize,
    pub unexpanded_count: usize,
    pub security_count: usize,
    /// Hardening notes: user-writable folders searched before the system folders.
    pub order_count: usize,
    /// PATH entries that no readable config file declares (tool manager / package
    /// manager injections). Excluded from every other count and from the score.
    pub session_count: usize,
    pub conflict_count: usize,
    pub path_entries: Vec<PathEntry>,
    pub conflicts: Vec<BinaryConflict>,
    pub variables: Vec<EnvVariable>,
    pub os_context: OsContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub created_at: String,
    pub title: String,
    pub description: String,
    pub is_automatic: bool,
    pub path_count: usize,
    pub var_count: usize,
    pub path_entries: Vec<PathEntry>,
    pub variables: Vec<EnvVariable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffLine {
    pub change_type: String, // "added" | "removed" | "unchanged"
    pub old_index: Option<usize>,
    pub new_index: Option<usize>,
    pub content: String,
    pub scope_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarDiff {
    pub key: String,
    pub change_type: String, // "added" | "removed" | "modified"
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub scope_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDiff {
    pub snapshot_id: String,
    pub snapshot_title: String,
    pub created_at: String,
    pub unified_diff: String,
    pub path_diffs: Vec<DiffLine>,
    pub var_diffs: Vec<VarDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub variables: Vec<EnvVariable>,
    pub path_entries: Vec<PathEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyChangesPayload {
    pub path_entries: Vec<PathEntry>,
    pub variables: Vec<EnvVariable>,
    pub snapshot_title: Option<String>,
    pub allow_uac_elevation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyChangesResult {
    pub success: bool,
    pub snapshot_id: String,
    pub broadcasted: bool,
    pub message: String,
    pub warnings: Vec<String>,
}

/// Whether applying `next` would erase an environment that currently has content.
///
/// Both lists are empty when the payload does not describe the environment at
/// all (a failed scan, a corrupt snapshot row, a hand-edited import). Applying
/// that is not a no-op: on Windows it clears the user PATH and every user
/// variable, and on Linux it writes an `env.sh` with no PATH. Refuse while the
/// current environment is known to be non-empty.
pub fn would_erase_environment(
    current_paths: &[PathEntry],
    current_vars: &[EnvVariable],
    next_paths: &[PathEntry],
    next_vars: &[EnvVariable],
) -> bool {
    next_paths.is_empty()
        && next_vars.is_empty()
        && (!current_paths.is_empty() || !current_vars.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn path(id: &str) -> PathEntry {
        PathEntry {
            id: id.to_string(),
            raw_value: "/usr/bin".to_string(),
            resolved_value: PathBuf::from("/usr/bin"),
            scope: Scope::System,
            source_text: None,
            exists: true,
            executable_count: 1,
            issues: Vec::new(),
        }
    }

    fn variable() -> EnvVariable {
        EnvVariable {
            key: "JAVA_HOME".to_string(),
            value: "/usr/lib/jvm/java".to_string(),
            is_expandable: false,
            scope: Scope::User,
            is_modified: false,
        }
    }

    #[test]
    fn an_empty_target_cannot_wipe_a_non_empty_environment() {
        let paths = [path("1")];
        let vars = [variable()];

        // A payload that describes neither scope is indistinguishable from a
        // scan that never ran and must be refused.
        assert!(would_erase_environment(&paths, &vars, &[], &[]));
        assert!(would_erase_environment(&[], &vars, &[], &[]));
        assert!(would_erase_environment(&paths, &[], &[], &[]));

        // A genuine deletion on one side is still allowed.
        assert!(!would_erase_environment(&paths, &vars, &paths, &[]));
        assert!(!would_erase_environment(&paths, &vars, &[], &vars));

        // An already-empty environment has nothing to protect.
        assert!(!would_erase_environment(&[], &[], &[], &[]));
    }
}
