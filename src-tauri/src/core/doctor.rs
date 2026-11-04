use crate::core::{DiagnosticIssue, PathEntry, Scope};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Normalize a path string for duplicate comparison:
/// - Trim whitespace and trailing slashes (`/` or `\`) except root `/` or `C:\`
/// - On Windows, convert to lowercase and unify slashes to `\`
pub fn normalize_path_for_comparison(path: &Path, raw: &str) -> String {
    let source = if !path.as_os_str().is_empty() {
        path.to_string_lossy().to_string()
    } else {
        raw.to_string()
    };

    let trimmed = source.trim();
    if cfg!(target_os = "windows") {
        let mut s = trimmed.replace('/', "\\").to_lowercase();
        while s.len() > 3 && s.ends_with('\\') {
            s.pop();
        }
        s
    } else {
        let mut s = trimmed.to_string();
        while s.len() > 1 && s.ends_with('/') {
            s.pop();
        }
        s
    }
}

/// Files this app writes itself: `~/.config/env-doctor/env.sh` and the
/// `environment.d` mirror. They copy the *live* environment, so their contents
/// are not user intent. Treating them as regular configuration would attribute
/// every entry to the app and turn the literal paths it just persisted into
/// fresh "hard-coded path" findings on the next scan.
pub fn is_app_generated_config(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    (name == "env.sh" && parent == "env-doctor")
        || ((name == "zz-env-doctor.conf" || name == "99-env-doctor.conf")
            && parent == "environment.d")
}

/// Resolve the *physical* directory behind a PATH entry, used by the
/// informational `ALIAS_PATH` rule.
///
/// `normalize_path_for_comparison` only guards against *textual* differences
/// (trailing separators, case). On merged-`/usr` distributions `/bin` and
/// `/usr/bin` are the very same physical directory reached through a symlink,
/// which that helper cannot see. Resolving the symlink lets us recognise the two
/// as aliases of one another.
///
/// This is deliberately *not* the basis of the `DUPLICATE` rule: aliasing is a
/// distribution default, so it is reported as a non-blocking tip rather than a
/// warning, and `Clean All` never merges aliases away. Falls back to textual
/// normalization for dead / non-resolvable paths.
pub fn canonical_directory_key(resolved: &Path, raw: &str) -> String {
    if let Ok(canonical) = std::fs::canonicalize(resolved) {
        return normalize_path_for_comparison(&canonical, raw);
    }
    normalize_path_for_comparison(resolved, raw)
}

/// Expand environment variables in a raw PATH entry string (`%VAR%` on Windows, `$VAR` / `${VAR}` / `~` on Unix)
pub fn expand_path_variables(raw: &str, env_map: &HashMap<String, String>) -> PathBuf {
    // Handle ~ on Unix or Windows
    let mut result = raw.trim().to_string();
    if result == "~" || result.starts_with("~/") || result.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            result = format!("{}{}", home_str, &result[1..]);
        }
    }

    // `%VAR%` is a Windows convention. On Unix a component may contain a
    // literal percent sign (`100%`), and treating a pair of them as a variable
    // reference would rewrite it.
    if cfg!(target_os = "windows") {
        result = expand_percent_style(&result, env_map);
    }
    expand_unix_style(&result, env_map).into()
}

/// Look up one variable name.
///
/// Windows environment names are case-insensitive, so only there is an
/// upper-case fallback acceptable. On Unix `${home}` must not silently read
/// `HOME`: the two names can hold different values (see `http_proxy`).
fn lookup_env(env_map: &HashMap<String, String>, name: &str) -> Option<String> {
    env_map
        .get(name)
        .or_else(|| {
            if cfg!(target_os = "windows") {
                env_map.get(&name.to_uppercase())
            } else {
                None
            }
        })
        .cloned()
        .or_else(|| std::env::var(name).ok())
}

/// Expand Windows-style `%VAR%`.
fn expand_percent_style(text: &str, env_map: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' {
            if let Some(end_offset) = chars[i + 1..].iter().position(|&c| c == '%') {
                let end = i + 1 + end_offset;
                if end > i + 1 {
                    let var_name: String = chars[i + 1..end].iter().collect();
                    if let Some(val) = lookup_env(env_map, &var_name) {
                        out.push_str(&val);
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Expand Unix-style `${VAR}`, `${VAR:-default}`, `${VAR:+alt}` and `$VAR`.
fn expand_unix_style(text: &str, env_map: &HashMap<String, String>) -> String {
    if !text.contains('$') {
        return text.to_string();
    }

    // The fallback word is part of the same expansion, so the shell expands its
    // variables too: `${TOOLS:-$HOME/.local/bin}` yields the home path. Without
    // this the stored origin would keep the literal `$HOME/...`, never match the
    // live component, and the folder would be misreported as a session entry.
    // Quoting inside the word keeps its shell meaning: a single-quoted default
    // is literal, and the quotes of a double-quoted default are removed.
    let expand_default = |word: &str| -> String {
        let trimmed = word.trim();
        if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
        let body = if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
            trimmed[1..trimmed.len() - 1].to_string()
        } else {
            word.to_string()
        };
        let percent_done = if cfg!(target_os = "windows") {
            expand_percent_style(&body, env_map)
        } else {
            body
        };
        expand_unix_style(&percent_done, env_map)
    };

    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut j = 0;
    while j < chars.len() {
        if chars[j] == '$' && j + 1 < chars.len() {
            if chars[j + 1] == '{' {
                if let Some(close_offset) = chars[j + 2..].iter().position(|&c| c == '}') {
                    let end = j + 2 + close_offset;
                    let inner: String = chars[j + 2..end].iter().collect();
                    // Shell default/alternate forms. `PATH=${TOOLS:-/opt/bin}:$PATH`
                    // is common in dotfiles; without this branch the brace is
                    // read as part of the variable name and the whole entry is
                    // reported as a missing folder.
                    let (var_name, default_value, alternate) =
                        if let Some(pos) = inner.find(":-") {
                            (
                                inner[..pos].to_string(),
                                Some(inner[pos + 2..].to_string()),
                                false,
                            )
                        } else if let Some(pos) = inner.find(":+") {
                            (
                                inner[..pos].to_string(),
                                Some(inner[pos + 2..].to_string()),
                                true,
                            )
                        } else {
                            (inner.clone(), None, false)
                        };
                    let resolved = lookup_env(env_map, &var_name);

                    let replacement = if alternate {
                        // `${VAR:+alt}`: alt when VAR is set and non-empty,
                        // nothing when it is unset or empty.
                        Some(match resolved {
                            Some(val) if !val.is_empty() => {
                                default_value.map(|word| expand_default(&word)).unwrap_or_default()
                            }
                            _ => String::new(),
                        })
                    } else {
                        match resolved {
                            Some(val) if !val.is_empty() => Some(val),
                            // Set but empty, or unset with a `:-default`.
                            Some(_) => {
                                default_value.map(|word| expand_default(&word))
                            }
                            None => default_value.map(|word| expand_default(&word)),
                        }
                    };

                    if let Some(val) = replacement {
                        out.push_str(&val);
                        j = end + 1;
                        continue;
                    }
                }
            } else if chars[j + 1].is_ascii_alphabetic() || chars[j + 1] == '_' {
                let mut end = j + 1;
                while end < chars.len()
                    && (chars[end].is_ascii_alphanumeric() || chars[end] == '_')
                {
                    end += 1;
                }
                let var_name: String = chars[j + 1..end].iter().collect();
                if let Some(val) = lookup_env(env_map, &var_name) {
                    out.push_str(&val);
                    j = end;
                    continue;
                }
            }
        }
        out.push(chars[j]);
        j += 1;
    }
    out
}

/// Check if a path is a critical OS system path that must NEVER be deleted (Section 9.1 Safe Guard)
pub fn is_protected_system_path(raw_value: &str, resolved_value: &Path) -> bool {
    let norm_resolved = normalize_path_for_comparison(resolved_value, raw_value);
    let norm_raw = raw_value.trim().replace('/', "\\").to_lowercase();

    if cfg!(target_os = "windows") {
        let protected_win = [
            "c:\\windows\\system32",
            "c:\\windows",
            "c:\\windows\\system32\\wbem",
            "c:\\windows\\system32\\windowspowershell\\v1.0",
            "%systemroot%\\system32",
            "%systemroot%",
            "%windir%\\system32",
            "%windir%",
        ];
        protected_win
            .iter()
            .any(|p| norm_resolved == *p || norm_raw.trim_end_matches('\\') == *p)
    } else {
        let protected_unix = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
        protected_unix
            .iter()
            .any(|p| norm_resolved == *p || raw_value.trim().trim_end_matches('/') == *p)
    }
}

/// Check if a path is one of the primary core OS binary directories (`System32` or `/usr/bin`, `/bin`).
///
/// Unlike [`is_protected_system_path`], this excludes secondary folders such as
/// `/usr/sbin` or `C:\Windows`: a written `PATH` that still contains only those
/// has lost the commands the operating system itself needs.
pub fn is_core_system_bin_dir(raw_value: &str, resolved_value: &Path) -> bool {
    let norm = normalize_path_for_comparison(resolved_value, raw_value);
    let raw_lower = raw_value.trim().replace('/', "\\").to_lowercase();
    if cfg!(target_os = "windows") {
        // Only `C:\Windows\System32` counts. A raw suffix alone is not enough:
        // `C:\Tools\system32` must not satisfy a safety check whose whole point
        // is that the real system folder is still in the written PATH.
        let raw_is_system32 = (raw_lower.starts_with("%systemroot%\\")
            || raw_lower.starts_with("%windir%\\"))
            && raw_lower.trim_end_matches('\\').ends_with("\\system32");
        norm.ends_with("\\windows\\system32") || raw_is_system32
    } else {
        norm == "/usr/bin" || norm == "/bin"
    }
}

/// Directories a distribution ships in the default `PATH` even when they are
/// empty. They are reserved install targets (`make install` writes to
/// `/usr/local/bin`, games packages to `/usr/games`), so "this folder is empty —
/// remove it from PATH" is wrong advice and must not lower the score.
fn is_distro_standard_bin_dir(raw_value: &str, resolved_value: &Path) -> bool {
    let norm = normalize_path_for_comparison(resolved_value, raw_value);
    if cfg!(target_os = "windows") {
        // Windows has no equivalent convention; only flag genuinely empty dirs.
        return false;
    }
    const STANDARD: &[&str] = &[
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/games",
        "/usr/local/libexec",
        "/usr/games",
        "/usr/bin",
        "/usr/sbin",
        "/bin",
        "/sbin",
    ];
    STANDARD.contains(&norm.as_str())
}

/// `true` when a `PATH` entry was contributed by the running process/session and
/// is not declared in any configuration file we can read. Those entries are not
/// the user's configuration: nothing is suggested for them and they are excluded
/// from the health score.
fn is_session_entry(entry: &PathEntry) -> bool {
    matches!(entry.scope, Scope::Process)
}

/// Detect if a directory can be shortened with `%USERPROFILE%` (Windows) or `$HOME` (Linux).
///
/// A `PATH` entry read from the process environment is always fully expanded
/// (`/home/dev/.cargo/bin`), even when the config file wrote `$HOME/.cargo/bin`.
/// Checking the raw value alone therefore reports "hard-coded home path" for
/// entries that are already written portably. When we know the original config
/// text we judge *that* instead, and only suggest a rewrite when the file really
/// spells the home folder out.
fn check_unexpanded_variable(entry: &PathEntry, home_dir: Option<&Path>) -> Option<String> {
    // The app's own generated files are excluded from this rule: the paths in
    // them were written from the live environment, not typed by the user.
    if let Scope::Dotfile { file_path, .. } = &entry.scope {
        if is_app_generated_config(file_path) {
            return None;
        }
    }

    if let Some(source) = entry.source_text.as_deref() {
        let source = source.trim();
        if source.contains('$') || source.contains('%') || source.starts_with('~') {
            return None;
        }
    }

    let raw_value = entry.raw_value.as_str();
    let trimmed = raw_value.trim();
    if trimmed.contains('%') || trimmed.contains('$') || trimmed.starts_with('~') {
        return None;
    }

    let home = home_dir?;
    let home_str = home.to_string_lossy();
    if home_str.is_empty() {
        return None;
    }

    if cfg!(target_os = "windows") {
        let raw_norm = trimmed.replace('/', "\\");
        let home_norm = home_str.replace('/', "\\");
        // `get` instead of direct slicing: a non-ASCII character before the
        // prefix length would make the byte index fall inside a character and
        // panic.
        if raw_norm.len() > home_norm.len()
            && raw_norm
                .get(..home_norm.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(&home_norm))
            && raw_norm.as_bytes().get(home_norm.len()) == Some(&b'\\')
        {
            let suffix = raw_norm.get(home_norm.len()..).unwrap_or_default();
            return Some(format!("%USERPROFILE%{}", suffix));
        }
    } else if trimmed.starts_with(home_str.as_ref())
        && trimmed.len() > home_str.len()
        && trimmed.as_bytes().get(home_str.len()) == Some(&b'/')
    {
        let suffix = &trimmed[home_str.len()..];
        return Some(format!("$HOME{}", suffix));
    }

    None
}

/// A folder every account on the machine can write to (world-writable without the
/// sticky bit). This is a genuine security exposure, so it carries a real score
/// penalty.
fn check_world_writable(entry: &PathEntry) -> Option<String> {
    if !entry.exists {
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&entry.resolved_value) {
            let mode = meta.permissions().mode();
            // World-writable without sticky bit
            if (mode & 0o002) != 0 && (mode & 0o1000) == 0 {
                return Some(
                    "This folder is writable by every user on the machine, so anyone can place a program here that would be run instead of the real command."
                        .to_string(),
                );
            }
        }
    }
    // Windows ACLs are not inspected: Rust's synthesized Windows permission bits
    // cannot express "Everyone: write", so the rule is documented as Unix-only
    // instead of reporting a wrong verdict.
    let _ = entry;

    None
}

/// A user-writable folder or temp/download directory that appears BEFORE the core
/// system binaries (`System32` / `/usr/bin`).
///
/// This is hardening advice, not a finding: prepending a per-user toolchain
/// directory is exactly how rustup, nvm, pyenv and asdf are meant to be set up, so
/// it is reported as a tip and costs no health score.
fn check_order_risk(
    entry: &PathEntry,
    index: usize,
    first_core_system_index: Option<usize>,
    home_dir: Option<&Path>,
) -> Option<String> {
    if !entry.exists {
        return None;
    }

    if let Some(sys_idx) = first_core_system_index {
        if index < sys_idx {
            let norm = normalize_path_for_comparison(&entry.resolved_value, &entry.raw_value);
            // Match whole path components, not substrings: `/opt/tmp-tools/bin`
            // and `/home/dev/tmpbin` are not temp folders.
            let is_temp_or_download = norm
                .split(|c| c == '/' || c == '\\')
                .any(|component| {
                    ["tmp", "temp", "downloads"]
                        .iter()
                        .any(|name| component.eq_ignore_ascii_case(name))
                });
            if is_temp_or_download {
                return Some(format!(
                    "This temp/download folder is searched before the system folders (position #{}), so a program placed here would run instead of the real system command.",
                    sys_idx + 1
                ));
            }

            if let Some(home) = home_dir {
                let home_norm = normalize_path_for_comparison(home, "");
                // Require a component boundary: `/home/dev` must not match
                // `/home/developer/bin`.
                if !home_norm.is_empty()
                    && norm
                        .strip_prefix(&home_norm)
                        .is_some_and(|rest| {
                            rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')
                        })
                {
                    return Some(format!(
                        "Your home folder is searched before the system folders (position #{}), so a program placed here would run instead of the real system command.",
                        sys_idx + 1
                    ));
                }
            }
        }
    }

    None
}

/// Run the diagnostic rules on a list of PathEntries and return updated entries.
///
/// Entries contributed by the running process/session (`Scope::Process`) are left
/// untouched: they were not declared in any configuration file, so there is
/// nothing the user could fix and they must not affect the health score. The UI
/// and the exported report list them separately.
pub fn analyze_path_entries(entries: &mut [PathEntry]) {
    let home_dir = dirs::home_dir();
    let first_core_system_index = entries
        .iter()
        .position(|e| is_core_system_bin_dir(&e.raw_value, &e.resolved_value));

    let mut seen_textual: HashMap<String, usize> = HashMap::new();
    // canonical folder -> (first PATH index, first *text* form) so the alias rule
    // works in both directions (`/bin` before `/usr/bin` and vice versa).
    let mut seen_canonical: HashMap<String, (usize, String)> = HashMap::new();

    for idx in 0..entries.len() {
        if is_session_entry(&entries[idx]) {
            entries[idx].issues = Vec::new();
            continue;
        }

        let mut issues = Vec::new();

        // Rule 1: DEAD_PATH
        if !entries[idx].exists {
            issues.push(DiagnosticIssue::DeadPath);
        } else if entries[idx].executable_count == 0
            && !is_distro_standard_bin_dir(&entries[idx].raw_value, &entries[idx].resolved_value)
        {
            // Rule 2: EMPTY_DIR (only when directory exists on disk and is not one
            // of the reserved install directories a distribution ships empty).
            issues.push(DiagnosticIssue::EmptyDirectory);
        }

        // Rule 3: DUPLICATE — the identical path text registered twice (after
        // slash / case normalization). This is the actionable kind: a redundant
        // entry the user (or a dotfile) really did add twice.
        let text_key =
            normalize_path_for_comparison(&entries[idx].resolved_value, &entries[idx].raw_value);
        let mut is_textual_duplicate = false;
        if !text_key.is_empty() {
            if let Some(&first_idx) = seen_textual.get(&text_key) {
                issues.push(DiagnosticIssue::Duplicate {
                    first_seen_index: first_idx,
                });
                is_textual_duplicate = true;
            } else {
                seen_textual.insert(text_key.clone(), idx);
            }
        }

        // Rule 3b: ALIAS_PATH — the same *physical* directory reached through a
        // symlink under a different name (e.g. `/bin` -> `/usr/bin`). Reported as
        // an informational tip only; it is not counted against the health score
        // and `Clean All` leaves it alone so distribution defaults survive.
        let canonical_key =
            canonical_directory_key(&entries[idx].resolved_value, &entries[idx].raw_value);
        if !canonical_key.is_empty() && !is_textual_duplicate {
            if let Some((first_idx, first_text)) = seen_canonical.get(&canonical_key) {
                // Two different spellings of the same physical folder. Flag the
                // later one whichever spelling happens to be the symlink: with
                // `/bin:/usr/bin` the first entry is the alias, so comparing only
                // against the canonical path would miss the pair entirely.
                if *first_text != text_key {
                    issues.push(DiagnosticIssue::AliasPath {
                        canonical: canonical_key.clone(),
                        first_seen_index: *first_idx,
                    });
                }
            }
        }
        if !canonical_key.is_empty() {
            seen_canonical
                .entry(canonical_key)
                .or_insert((idx, text_key.clone()));
        }

        // Rule 4: UNEXPANDED
        if let Some(suggested) = check_unexpanded_variable(&entries[idx], home_dir.as_deref()) {
            issues.push(DiagnosticIssue::UnexpandedVariable { suggested });
        }

        // Rule 5: PERMISSION_WARN — a genuinely world-writable folder.
        if let Some(reason) = check_world_writable(&entries[idx]) {
            issues.push(DiagnosticIssue::SecurityRisk { reason });
        }

        // Rule 6: ORDER_TIP — user-writable folder searched before the system
        // folders. Hardening advice only; no score penalty (see `check_order_risk`).
        if let Some(reason) = check_order_risk(
            &entries[idx],
            idx,
            first_core_system_index,
            home_dir.as_deref(),
        ) {
            issues.push(DiagnosticIssue::OrderRisk { reason });
        }

        entries[idx].issues = issues;
    }
}

/// Compute overall PATH Health Score (1..=100).
///
/// Each category contributes a capped amount so that a single noisy category can
/// never drive the score all the way to 0: the number keeps telling the user how
/// bad things are instead of saturating. The caps sum to 99, so the score is a
/// real 1-100 range. Session entries carry no issues and cost nothing.
pub fn calculate_health_score(entries: &[PathEntry], conflict_count: usize) -> u8 {
    let (mut dead, mut duplicate, mut empty, mut unexpanded, mut security) = (0usize, 0, 0, 0, 0);

    for entry in entries {
        for issue in &entry.issues {
            match issue {
                DiagnosticIssue::DeadPath => dead += 1,
                DiagnosticIssue::Duplicate { .. } => duplicate += 1,
                // Informational only (distro symlink alias): no penalty.
                DiagnosticIssue::AliasPath { .. } => {}
                DiagnosticIssue::EmptyDirectory => empty += 1,
                DiagnosticIssue::UnexpandedVariable { .. } => unexpanded += 1,
                DiagnosticIssue::SecurityRisk { .. } => security += 1,
                // Hardening advice only: standard tool-manager setup, no penalty.
                DiagnosticIssue::OrderRisk { .. } => {}
            }
        }
    }

    let penalty = (dead * 8).min(30)
        + (duplicate * 5).min(15)
        + (empty * 3).min(9)
        + (unexpanded * 2).min(8)
        + (security * 10).min(25)
        + (conflict_count * 2).min(12);

    100usize.saturating_sub(penalty.min(99)) as u8
}

/// One-click Clean All:
/// - Removes DeadPath entries (unless protected system path). A folder that does
///   not exist can never resolve a command, so this is safe for session entries
///   too — they are dropped rather than frozen into the saved configuration.
/// - Deduplicates Duplicate entries (preserving first seen)
/// - Applies UnexpandedVariable suggestions (`%USERPROFILE%` / `$HOME`)
pub fn clean_path_entries(entries: &[PathEntry], shorten_unexpanded: bool) -> Vec<PathEntry> {
    let mut cleaned = Vec::with_capacity(entries.len());
    // A configured entry always wins over a session entry with the same text,
    // wherever it appears in the list. Apply writes the configured copy and (for
    // a live tool folder) also keeps the session copy, so keeping both would
    // bake a duplicate into the saved PATH. Dropping only the session copy never
    // loses configuration: the configured entry is the one that is saved.
    let configured_keys: HashSet<String> = entries
        .iter()
        .filter(|entry| entry.scope != Scope::Process)
        .filter(|entry| {
            entry.exists || is_protected_system_path(&entry.raw_value, &entry.resolved_value)
        })
        .map(|entry| normalize_path_for_comparison(&entry.resolved_value, &entry.raw_value))
        .filter(|key| !key.is_empty())
        .collect();
    let mut seen_configured = HashMap::new();
    let mut seen_session = HashMap::new();

    for entry in entries {
        let is_protected = is_protected_system_path(&entry.raw_value, &entry.resolved_value);

        // Skip dead paths unless protected
        if !entry.exists && !is_protected {
            continue;
        }

        // Skip duplicates (identical path text). Symlink aliases such as
        // `/bin` -> `/usr/bin` are intentionally preserved: they are equivalent
        // at runtime and removing them only diverges from the distribution
        // default without buying anything.
        let norm_key = normalize_path_for_comparison(&entry.resolved_value, &entry.raw_value);
        if !norm_key.is_empty() {
            let is_session = entry.scope == Scope::Process;
            let seen = if is_session {
                &mut seen_session
            } else {
                &mut seen_configured
            };
            if seen.contains_key(&norm_key)
                || (is_session && configured_keys.contains(&norm_key))
            {
                continue;
            }
            seen.insert(norm_key, cleaned.len());
        }

        let mut updated = entry.clone();
        if shorten_unexpanded {
            for issue in &entry.issues {
                if let DiagnosticIssue::UnexpandedVariable { suggested } = issue {
                    updated.raw_value = suggested.clone();
                }
            }
        }
        cleaned.push(updated);
    }

    analyze_path_entries(&mut cleaned);
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::Scope;

    #[test]
    fn path_variables_support_shell_default_and_alternate_forms() {
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/home/dev".to_string());
        env.insert("EMPTY".to_string(), String::new());

        let expand = |raw: &str| expand_path_variables(raw, &env).to_string_lossy().to_string();

        assert_eq!(expand("$HOME/bin"), "/home/dev/bin");
        assert_eq!(expand("${HOME}/bin"), "/home/dev/bin");
        assert_eq!(expand("${MISSING:-/opt/fallback}/bin"), "/opt/fallback/bin");
        assert_eq!(expand("${EMPTY:-/opt/fallback}"), "/opt/fallback");
        assert_eq!(expand("${HOME:+found}"), "found");
        assert_eq!(expand("${MISSING:+found}"), "");
        // The fallback word is expanded like the shell expands it.
        assert_eq!(expand("${MISSING:-$HOME/bin}"), "/home/dev/bin");
        assert_eq!(expand("${HOME:-$MISSING/bin}"), "/home/dev");
        assert_eq!(expand("${MISSING:-'$HOME'}"), "$HOME");
        assert_eq!(expand("${MISSING:-\"$HOME/bin\"}"), "/home/dev/bin");
        // No value and no default: leave the text alone rather than invent one.
        assert_eq!(expand("${MISSING}/bin"), "${MISSING}/bin");
    }

    #[test]
    fn percent_variables_expand_only_on_windows() {
        // `%VAR%` is a Windows convention. On Unix a percent sign is ordinary
        // text (e.g. a folder named `100%`), and pairing two of them must not
        // rewrite the component.
        let mut env = HashMap::new();
        env.insert("NAME".to_string(), "value".to_string());
        let expand = |raw: &str| expand_path_variables(raw, &env).to_string_lossy().to_string();

        if cfg!(target_os = "windows") {
            assert_eq!(expand("%NAME%/x"), "value/x");
        } else {
            assert_eq!(expand("%NAME%/x"), "%NAME%/x");
            assert_eq!(expand("/opt/100%/bin"), "/opt/100%/bin");
        }
    }

    #[test]
    fn unix_variable_lookups_do_not_fold_case() {
        // `http_proxy` and `HTTP_PROXY` can hold different values. A lowercase
        // reference must not silently read the upper-case twin.
        let mut env = HashMap::new();
        env.insert("http_proxy".to_string(), "http://lower".to_string());
        env.insert("HTTP_PROXY".to_string(), "http://upper".to_string());

        let expand = |raw: &str| expand_path_variables(raw, &env).to_string_lossy().to_string();
        assert_eq!(expand("${http_proxy}/x"), "http://lower/x");
        assert_eq!(expand("${HTTP_PROXY}/x"), "http://upper/x");
        assert_eq!(expand("$http_proxy/x"), "http://lower/x");

        // With only the upper-case key present, Unix must leave the lower-case
        // reference alone. Windows is case-insensitive and does resolve it.
        let mut upper_only = HashMap::new();
        upper_only.insert("HOME".to_string(), "/home/dev".to_string());
        let expand_upper =
            |raw: &str| expand_path_variables(raw, &upper_only).to_string_lossy().to_string();
        assert_eq!(expand_upper("${HOME}/x"), "/home/dev/x");
        if cfg!(target_os = "windows") {
            assert_eq!(expand_upper("${home}/x"), "/home/dev/x");
        } else {
            assert_eq!(expand_upper("${home}/x"), "${home}/x");
        }
    }

    fn path_entry(id: &str, scope: Scope, dir: &Path) -> PathEntry {
        PathEntry {
            id: id.to_string(),
            raw_value: dir.to_string_lossy().to_string(),
            resolved_value: dir.to_path_buf(),
            scope,
            source_text: None,
            exists: true,
            executable_count: 1,
            issues: vec![],
        }
    }

    #[test]
    fn only_the_real_core_bin_directory_counts() {
        if cfg!(target_os = "windows") {
            assert!(is_core_system_bin_dir(
                "C:\\Windows\\System32",
                Path::new("C:\\Windows\\System32")
            ));
            assert!(is_core_system_bin_dir(
                "%SystemRoot%\\System32",
                Path::new("%SystemRoot%\\System32")
            ));
            assert!(!is_core_system_bin_dir(
                "C:\\Tools\\system32",
                Path::new("C:\\Tools\\system32")
            ));
            // `C:\Windows` is protected from deletion, but it is not where the
            // OS commands live.
            assert!(!is_core_system_bin_dir(
                "C:\\Windows",
                Path::new("C:\\Windows")
            ));
        } else {
            assert!(is_core_system_bin_dir("/usr/bin", Path::new("/usr/bin")));
            assert!(is_core_system_bin_dir("/bin/", Path::new("/bin")));
            assert!(!is_core_system_bin_dir("/usr/sbin", Path::new("/usr/sbin")));
            assert!(!is_core_system_bin_dir(
                "/opt/usr/bin",
                Path::new("/opt/usr/bin")
            ));
        }
    }

    #[test]
    fn clean_all_keeps_the_configured_copy_of_a_duplicate() {
        // Apply writes the configured copy and may also keep a live session
        // copy, so Clean All must drop the session duplicate and keep the
        // configured entry — regardless of which one comes first.
        let base = std::env::temp_dir().join(format!("envdoc_clean_{}", uuid::Uuid::new_v4()));
        let dir = base.join("tools");
        std::fs::create_dir_all(&dir).unwrap();

        for (first, second) in [
            (Scope::Process, Scope::User),
            (Scope::User, Scope::Process),
        ] {
            let cleaned = clean_path_entries(
                &[
                    path_entry("1", first, &dir),
                    path_entry("2", second, &dir),
                ],
                false,
            );
            assert_eq!(cleaned.len(), 1, "the folder must be written once");
            assert_ne!(
                cleaned[0].scope,
                Scope::Process,
                "the configured copy must be the survivor"
            );
        }

        // Duplicates within one class are still merged.
        let session_only = clean_path_entries(
            &[
                path_entry("3", Scope::Process, &dir),
                path_entry("4", Scope::Process, &dir),
            ],
            false,
        );
        assert_eq!(session_only.len(), 1);
        assert_eq!(session_only[0].scope, Scope::Process);

        let configured_only = clean_path_entries(
            &[
                path_entry("5", Scope::User, &dir),
                path_entry("6", Scope::Dotfile {
                    file_path: PathBuf::from("/home/dev/.bashrc"),
                    line_number: 1,
                    expanded: false,
                }, &dir),
            ],
            false,
        );
        assert_eq!(configured_only.len(), 1);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_apps_own_generated_files_are_recognized() {
        assert!(is_app_generated_config(Path::new(
            "/home/dev/.config/env-doctor/env.sh"
        )));
        assert!(is_app_generated_config(Path::new(
            "/home/dev/.config/environment.d/zz-env-doctor.conf"
        )));
        assert!(is_app_generated_config(Path::new(
            "/home/dev/.config/environment.d/99-env-doctor.conf"
        )));
        assert!(!is_app_generated_config(Path::new(
            "/home/dev/.config/environment.d/50-other.conf"
        )));
        assert!(!is_app_generated_config(Path::new("/home/dev/project/env.sh")));
    }

    #[test]
    fn test_duplicate_and_dead_path_detection() {
        // `normalize_path_for_comparison` only strips the separator that is native to
        // the host OS (backslash on Windows, forward slash elsewhere). Use a
        // platform-appropriate non-existent directory so the trailing-separator
        // duplicate rule is exercised correctly on both Windows and Unix.
        let (raw_with_sep, raw_without_sep) = if cfg!(target_os = "windows") {
            ("C:\\NonExistentDir12345\\", "C:\\NonExistentDir12345")
        } else {
            ("/non_existent_dir_12345/", "/non_existent_dir_12345")
        };

        let mut entries = vec![
            PathEntry {
                id: "1".into(),
                raw_value: raw_with_sep.into(),
                resolved_value: PathBuf::from(raw_with_sep),
                scope: Scope::User,
                source_text: None,
                exists: false,
                executable_count: 0,
                issues: vec![],
            },
            PathEntry {
                id: "2".into(),
                raw_value: raw_without_sep.into(),
                resolved_value: PathBuf::from(raw_without_sep),
                scope: Scope::User,
                source_text: None,
                exists: false,
                executable_count: 0,
                issues: vec![],
            },
        ];

        analyze_path_entries(&mut entries);
        assert!(entries[0].issues.contains(&DiagnosticIssue::DeadPath));
        assert!(entries[1]
            .issues
            .contains(&DiagnosticIssue::Duplicate { first_seen_index: 0 }));

        let cleaned = clean_path_entries(&entries, true);
        assert_eq!(cleaned.len(), 0);
    }

    #[test]
    fn test_protected_system_path_safeguard() {
        if cfg!(target_os = "windows") {
            assert!(is_protected_system_path(
                "C:\\Windows\\System32\\",
                Path::new("C:\\Windows\\System32")
            ));
        } else {
            assert!(is_protected_system_path("/usr/bin/", Path::new("/usr/bin")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_symlinked_directory_alias_is_informational() {
        // `/bin -> /usr/bin` on merged-`/usr` systems: the same physical
        // directory reached through two names is an *informational* alias, not an
        // actionable duplicate — the distribution default PATH must survive.
        let base = std::env::temp_dir().join(format!("envdoc_alias_{}", uuid::Uuid::new_v4()));
        let real_dir = base.join("real");
        std::fs::create_dir_all(&real_dir).unwrap();
        let alias_dir = base.join("alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let make = |id: &str, dir: &Path| PathEntry {
            id: id.to_string(),
            raw_value: dir.to_string_lossy().to_string(),
            resolved_value: dir.to_path_buf(),
            scope: Scope::User,
            // The fixture lives under the platform temp directory, which may be
            // inside `$HOME` (e.g. `TMPDIR=$HOME/tmp`). A portable declaring
            // text keeps the UNEXPANDED rule — which this test is not about —
            // from changing the expected score.
            source_text: Some("$HOME/tools".to_string()),
            exists: true,
            executable_count: 1,
            issues: vec![],
        };

        let mut entries = vec![make("1", &real_dir), make("2", &alias_dir)];
        analyze_path_entries(&mut entries);

        let canonical = std::fs::canonicalize(&real_dir)
            .unwrap()
            .to_string_lossy()
            .to_string();

        assert!(
            entries[1].issues.contains(&DiagnosticIssue::AliasPath {
                canonical: canonical.clone(),
                first_seen_index: 0,
            }),
            "alias should be reported, got {:?}",
            entries[1].issues
        );
        assert!(
            !entries[1]
                .issues
                .iter()
                .any(|i| matches!(i, DiagnosticIssue::Duplicate { .. })),
            "an alias must not be reported as a duplicate"
        );

        // Informational aliases must not lower the health score.
        assert_eq!(calculate_health_score(&entries, 0), 100);

        // `Clean All` must preserve both entries.
        let cleaned = clean_path_entries(&entries, false);
        assert_eq!(
            cleaned.len(),
            2,
            "aliased directory must be preserved by Clean All"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn alias_is_detected_when_the_symlink_comes_first() {
        // Most systems list `/usr/bin` before `/bin`, but nothing guarantees it:
        // `PATH=/bin:/usr/bin` must still report the pair as an informational
        // alias instead of silently showing two unrelated folders.
        let base = std::env::temp_dir().join(format!("envdoc_alias2_{}", uuid::Uuid::new_v4()));
        let real_dir = base.join("real");
        std::fs::create_dir_all(&real_dir).unwrap();
        let alias_dir = base.join("alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let make = |id: &str, dir: &Path| PathEntry {
            id: id.to_string(),
            raw_value: dir.to_string_lossy().to_string(),
            resolved_value: dir.to_path_buf(),
            scope: Scope::User,
            // Same portability guard as the alias test above: the temp directory
            // can be inside `$HOME`, and this test asserts the alias result only.
            source_text: Some("$HOME/tools".to_string()),
            exists: true,
            executable_count: 1,
            issues: vec![],
        };

        let mut entries = vec![make("1", &alias_dir), make("2", &real_dir)];
        analyze_path_entries(&mut entries);

        let canonical = std::fs::canonicalize(&real_dir)
            .unwrap()
            .to_string_lossy()
            .to_string();

        assert!(
            entries[1].issues.contains(&DiagnosticIssue::AliasPath {
                canonical,
                first_seen_index: 0,
            }),
            "the second spelling of the same folder must be flagged, got {:?}",
            entries[1].issues
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn test_literal_duplicate_is_detected_and_merged() {
        // The actionable case: the identical path text registered twice.
        let base = std::env::temp_dir().join(format!("envdoc_dupdir_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();

        let make = |id: &str| PathEntry {
            id: id.to_string(),
            raw_value: base.to_string_lossy().to_string(),
            resolved_value: base.clone(),
            scope: Scope::User,
            // The temp folder may be inside `$HOME`; keep the UNEXPANDED rule
            // (which this test is not about) out of the expected score.
            source_text: Some("$HOME/dup".to_string()),
            exists: true,
            executable_count: 3,
            issues: vec![],
        };

        let mut entries = vec![make("1"), make("2")];
        analyze_path_entries(&mut entries);

        assert!(entries[1]
            .issues
            .contains(&DiagnosticIssue::Duplicate { first_seen_index: 0 }));
        assert_eq!(calculate_health_score(&entries, 0), 95);

        let cleaned = clean_path_entries(&entries, false);
        assert_eq!(cleaned.len(), 1, "literal duplicate should be merged away");

        std::fs::remove_dir_all(&base).ok();
    }

    fn entry_with(id: &str, scope: Scope, raw: &str, exists: bool) -> PathEntry {
        PathEntry {
            id: id.to_string(),
            raw_value: raw.to_string(),
            resolved_value: PathBuf::from(raw),
            scope,
            source_text: None,
            exists,
            executable_count: if exists { 1 } else { 0 },
            issues: vec![],
        }
    }

    #[test]
    fn session_entries_are_not_problems_and_cost_no_score() {
        // `npm run` injects `node_modules/.bin` directories for the project and
        // every ancestor, most of which do not exist. They are not declared in any
        // config file, so they must not be reported as dead paths or lower the score.
        let mut entries = vec![
            entry_with(
                "1",
                Scope::Process,
                "/home/dev/project/node_modules/.bin",
                true,
            ),
            entry_with("2", Scope::Process, "/home/dev/node_modules/.bin", false),
            entry_with("3", Scope::Process, "/node_modules/.bin", false),
        ];

        analyze_path_entries(&mut entries);

        assert!(
            entries.iter().all(|e| e.issues.is_empty()),
            "session entries must produce no findings, got {:?}",
            entries.iter().map(|e| &e.issues).collect::<Vec<_>>()
        );
        assert_eq!(calculate_health_score(&entries, 0), 100);
    }

    #[test]
    fn portable_source_text_is_not_reported_as_hard_coded() {
        let home = dirs::home_dir().expect("home dir");
        let resolved = home.join(".cargo/bin");
        let raw = resolved.to_string_lossy().to_string();

        // The config file wrote `$HOME/.cargo/bin`; the process PATH only shows the
        // expanded result. That is portable and must not be flagged.
        let mut portable = vec![PathEntry {
            source_text: Some("$HOME/.cargo/bin".to_string()),
            ..entry_with("1", Scope::User, &raw, true)
        }];
        analyze_path_entries(&mut portable);
        assert!(
            !portable[0]
                .issues
                .iter()
                .any(|i| matches!(i, DiagnosticIssue::UnexpandedVariable { .. })),
            "an entry written with $HOME must not be reported as hard-coded"
        );

        // The same directory spelled out literally in a dotfile is a real finding.
        let mut literal = vec![entry_with("1", Scope::User, &raw, true)];
        analyze_path_entries(&mut literal);
        assert!(
            literal[0]
                .issues
                .iter()
                .any(|i| matches!(i, DiagnosticIssue::UnexpandedVariable { .. })),
            "a literal home path must still be reported"
        );
    }

    #[cfg(unix)]
    #[test]
    fn distro_standard_empty_dirs_are_not_flagged() {
        for dir in ["/usr/local/bin", "/usr/local/sbin", "/usr/local/games"] {
            assert!(
                is_distro_standard_bin_dir(dir, Path::new(dir)),
                "{dir} is a reserved install directory"
            );

            let mut entries = vec![PathEntry {
                executable_count: 0,
                ..entry_with("1", Scope::System, dir, true)
            }];
            analyze_path_entries(&mut entries);
            assert!(
                !entries[0]
                    .issues
                    .iter()
                    .any(|i| matches!(i, DiagnosticIssue::EmptyDirectory)),
                "{dir} is shipped empty on purpose and must not be flagged"
            );

            // A genuinely unexpected empty directory is still reported.
            let mut custom = vec![PathEntry {
                executable_count: 0,
                ..entry_with("1", Scope::User, "/home/dev/mybin", true)
            }];
            analyze_path_entries(&mut custom);
            assert!(custom[0]
                .issues
                .iter()
                .any(|i| matches!(i, DiagnosticIssue::EmptyDirectory)));
        }
    }

    #[test]
    fn order_risk_is_a_free_hardening_tip() {
        let core_bin = if cfg!(target_os = "windows") {
            "C:\\Windows\\System32"
        } else {
            "/usr/bin"
        };
        let home = dirs::home_dir().expect("home dir");
        let home_entry = PathEntry {
            source_text: Some("$HOME".to_string()),
            ..entry_with("1", Scope::User, &home.to_string_lossy(), true)
        };

        let mut entries = vec![
            home_entry,
            entry_with("2", Scope::System, core_bin, true),
        ];
        analyze_path_entries(&mut entries);

        assert!(
            entries[0]
                .issues
                .iter()
                .any(|i| matches!(i, DiagnosticIssue::OrderRisk { .. })),
            "a user directory before /usr/bin is a hardening tip"
        );
        assert!(
            !entries[0]
                .issues
                .iter()
                .any(|i| matches!(i, DiagnosticIssue::SecurityRisk { .. })),
            "a normal home directory is not world-writable"
        );
        assert_eq!(
            calculate_health_score(&entries, 0),
            100,
            "a standard tool-manager layout must not cost score"
        );
    }

    #[test]
    fn order_risk_uses_path_components_not_substrings() {
        let core_bin = if cfg!(target_os = "windows") {
            "C:\\Windows\\System32"
        } else {
            "/usr/bin"
        };
        let home = dirs::home_dir().expect("home dir");
        // Same textual prefix as the home folder, but a different directory.
        let sibling = format!("{}2/bin", home.to_string_lossy());

        let mut entries = vec![
            entry_with("1", Scope::User, "/opt/tmp-tools/bin", true),
            entry_with("2", Scope::User, &sibling, true),
            entry_with("3", Scope::User, "/tmp/env-doctor-bin", true),
            entry_with("4", Scope::System, core_bin, true),
        ];
        analyze_path_entries(&mut entries);

        let has_order_risk = |index: usize| {
            entries[index]
                .issues
                .iter()
                .any(|i| matches!(i, DiagnosticIssue::OrderRisk { .. }))
        };

        assert!(
            !has_order_risk(0),
            "/opt/tmp-tools/bin merely contains \"tmp\" and is not a temp folder"
        );
        assert!(
            !has_order_risk(1),
            "{sibling} shares a prefix with {home:?} but is not inside it"
        );
        assert!(has_order_risk(2), "/tmp/env-doctor-bin is a temp folder");
    }

    #[test]
    fn score_cannot_saturate_to_zero() {
        // Every category maxed out at once still leaves a readable score instead of
        // a flat 0 that hides how bad things are.
        let (mut path_entries, mut issues) = (Vec::new(), Vec::new());
        for _ in 0..10 {
            issues.push(DiagnosticIssue::DeadPath);
            issues.push(DiagnosticIssue::Duplicate {
                first_seen_index: 0,
            });
            issues.push(DiagnosticIssue::EmptyDirectory);
            issues.push(DiagnosticIssue::UnexpandedVariable {
                suggested: "$HOME/x".to_string(),
            });
            issues.push(DiagnosticIssue::SecurityRisk {
                reason: "world writable".to_string(),
            });
        }
        path_entries.push(PathEntry {
            issues,
            ..entry_with("1", Scope::User, "/home/dev/bin", true)
        });

        assert_eq!(calculate_health_score(&path_entries, 100), 1);
    }
}
