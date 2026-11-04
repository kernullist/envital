use crate::core::{BinaryConflict, BinaryInstance, DirectoryExecutable, PathEntry, Scope};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Known developer CLI tools for which we extract `--version` hints when a conflict is detected
const VERSION_PROBABLE_BINARIES: &[&str] = &[
    "python", "python3", "pip", "pip3", "node", "npm", "pnpm", "yarn", "bun", "deno", "java",
    "javac", "go", "rustc", "cargo", "git", "gcc", "g++", "clang", "cmake", "make", "ninja",
    "dotnet", "ruby", "php", "perl", "lua", "curl", "tar", "ssh", "docker", "kubectl", "gh",
    "uv", "pwsh", "winget",
];

/// Get valid executable extensions on Windows from `PATHEXT`
fn get_windows_pathext() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    raw.split(';')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_lowercase())
        .collect()
}

/// Check if a file entry is an executable binary/script and return its normalized command name
pub fn classify_executable(path: &Path, pathext: &[String]) -> Option<(String, usize)> {
    // Follow metadata safely; if broken symlink, ignore
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }

    let file_name = path.file_name()?.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        let lower = file_name.to_lowercase();
        for (priority, ext) in pathext.iter().enumerate() {
            // `strip_suffix` rather than byte arithmetic: lowercasing can change
            // a filename's byte length (non-ASCII characters), which would make
            // `lower.len() - ext.len()` land inside a multi-byte character.
            if let Some(stem) = lower.strip_suffix(ext.as_str()) {
                if !stem.is_empty() {
                    return Some((stem.to_string(), priority));
                }
            }
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = pathext;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode();
            if (mode & 0o111) == 0 {
                return None;
            }
            Some((file_name, 0))
        }
        #[cfg(not(unix))]
        {
            Some((file_name, 0))
        }
    }
}

/// Scan a single directory for executables (Depth = 1).
///
/// The result is one entry per *command name*, which is what a user sees when they
/// list the directory and what the shell can actually resolve. Names that are
/// hardlinks or symlinks to the same physical binary are still counted separately
/// here (`/snap/bin/firefox` and `/snap/bin/snap-store` both point at
/// `/usr/bin/snap` but are two different commands). Deduplicating by physical
/// identity happens *across* PATH entries in `scan_path_and_conflicts`, which is
/// where it prevents bogus shadowing conflicts.
pub fn scan_directory_executables(dir: &Path) -> Vec<(String, PathBuf)> {
    if !dir.exists() || !dir.is_dir() {
        return Vec::new();
    }

    let pathext = get_windows_pathext();
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    // Map command_name -> (pathext_priority, PathBuf) to pick highest priority extension within the same directory
    let mut found: HashMap<String, (usize, PathBuf)> = HashMap::new();

    // No entry cap: `read_dir` order is filesystem-dependent, so truncating a
    // large directory (`/usr/bin` on a package-heavy machine) would make the
    // executable count and the conflict list change between two scans of the
    // same folder. Both are documented as one entry per command name.
    for entry_res in read_dir {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();

        if let Some((cmd_name, priority)) = classify_executable(&path, &pathext) {
            match found.get(&cmd_name) {
                Some(&(existing_prio, _)) if existing_prio <= priority => {}
                _ => {
                    found.insert(cmd_name, (priority, path));
                }
            }
        }
    }

    let mut result: Vec<(String, PathBuf)> = found
        .into_iter()
        .map(|(name, (_, path))| (name, path))
        .collect();
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}

/// Extract version string with a strict 300ms timeout (Section 4.2.3)
pub fn probe_binary_version(full_path: &Path, binary_name: &str) -> Option<String> {
    let path_str = full_path.to_string_lossy().to_lowercase();

    // Detect WindowsApps 0-byte App Execution Alias stub
    if cfg!(target_os = "windows") && path_str.contains("windowsapps") {
        if let Ok(meta) = fs::metadata(full_path) {
            if meta.len() == 0 {
                return Some("WindowsApps Store Alias (Stub)".to_string());
            }
        }
    }

    let lower_name = binary_name.to_lowercase();
    if !VERSION_PROBABLE_BINARIES.contains(&lower_name.as_str()) {
        return None;
    }

    let flag = if lower_name == "java" || lower_name == "javac" {
        "-version"
    } else if lower_name == "go" {
        "version"
    } else {
        "--version"
    };

    let mut cmd = Command::new(full_path);
    cmd.arg(flag)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().ok()?;
    let start = Instant::now();
    let timeout = Duration::from_millis(300);

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let output = child.wait_with_output().ok()?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let combined = if !stdout.trim().is_empty() {
                    stdout.trim()
                } else {
                    stderr.trim()
                };
                let first_line = combined.lines().next()?.trim();
                if first_line.is_empty() {
                    return None;
                }
                let cleaned = first_line.chars().take(64).collect::<String>();
                return Some(cleaned);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

/// Physical identity `(device, inode)` of a file, used to collapse symlink and
/// hardlink aliases of the *same* binary. On merged-`/usr` Linux layouts
/// (`/bin -> /usr/bin`, `/sbin -> /usr/sbin`) and distributions that symlink
/// `/usr/sbin/* -> ../bin/*`, the exact same executable shows up under several
/// PATH directories; without this they would be reported as thousands of bogus
/// "shadowing" conflicts. Returns `None` when the platform cannot provide one,
/// in which case callers fall back to normalized path comparison.
fn file_identity(path: &Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Whether every account on the machine can write into this directory.
///
/// Used to avoid executing binaries during version probing: a world-writable
/// PATH folder is where another account could plant a program, and probing it
/// with `--version` would run that code as the current user.
#[cfg(unix)]
fn directory_is_world_writable(dir: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(dir)
        .map(|meta| (meta.permissions().mode() & 0o002) != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn directory_is_world_writable(_dir: &Path) -> bool {
    false
}

/// Scan all PATH entries, update `exists` and `executable_count` on each entry,
/// and return all detected BinaryConflicts (where a command appears in 2+ distinct PATH entries).
pub fn scan_path_and_conflicts(
    entries: &mut [PathEntry],
    probe_versions: bool,
) -> Vec<BinaryConflict> {
    // Map binary_name -> Vec<(path_entry_index, PathBuf)>
    let mut binary_occurrences: HashMap<String, Vec<(usize, PathBuf)>> = HashMap::new();
    // Deduplicate identical physical directories so duplicate PATH entries don't create fake shadowing against themselves
    let mut dir_cache: HashMap<String, Vec<(String, PathBuf)>> = HashMap::new();

    for (idx, entry) in entries.iter_mut().enumerate() {
        let dir = &entry.resolved_value;
        entry.exists = dir.exists() && dir.is_dir();
        if !entry.exists {
            entry.executable_count = 0;
            continue;
        }

        // Resolve symlinked directories (`/bin -> /usr/bin`, `/sbin -> /usr/sbin`)
        // so an aliased directory is scanned once and shares a single cache entry
        // instead of being re-scanned for every PATH alias.
        let canonical_dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.clone());
        let norm_dir = crate::core::doctor::normalize_path_for_comparison(
            &canonical_dir,
            &entry.raw_value,
        );

        let exes = dir_cache
            .entry(norm_dir)
            .or_insert_with(|| scan_directory_executables(&canonical_dir))
            .clone();

        entry.executable_count = exes.len();

        // Session entries (Scope::Process) are injected by the running process,
        // not declared in any config file: the analyzer gives them no findings and
        // the health score ignores them. Conflicts are findings too, so a session
        // folder must not manufacture one against a real config entry (otherwise
        // `node_modules/.bin` would silently cost points the user cannot fix).
        if entry.scope == Scope::Process {
            continue;
        }

        for (bin_name, full_path) in exes {
            let list = binary_occurrences.entry(bin_name).or_default();
            // Avoid counting the same *physical* binary twice (identical path,
            // symlink alias, or hardlink) — these are not real shadowing conflicts.
            let full_id = file_identity(&full_path);
            let norm_file = crate::core::doctor::normalize_path_for_comparison(&full_path, "");
            let already_recorded = list.iter().any(|(_, existing_path)| {
                match (full_id, file_identity(existing_path)) {
                    (Some(a), Some(b)) => a == b,
                    _ => {
                        crate::core::doctor::normalize_path_for_comparison(existing_path, "")
                            == norm_file
                    }
                }
            });
            if !already_recorded {
                list.push((idx, full_path));
            }
        }
    }

    // Filter to binaries with 2+ distinct locations
    let mut conflicts: Vec<BinaryConflict> = binary_occurrences
        .into_iter()
        .filter(|(_, locs)| locs.len() >= 2)
        .map(|(binary_name, mut locs)| {
            // Order instances by PATH priority so `locations[0]` is always the
            // binary that actually executes (the lowest PATH index wins) and
            // mark exactly that one as active.
            locs.sort_by_key(|(path_entry_index, _)| *path_entry_index);
            let active_index = locs.first().map(|(i, _)| *i);
            let locations = locs
                .into_iter()
                .map(|(path_entry_index, full_path)| BinaryInstance {
                    full_path,
                    path_entry_index,
                    is_active: Some(path_entry_index) == active_index,
                    version_hint: None,
                })
                .collect();
            BinaryConflict {
                binary_name,
                locations,
            }
        })
        .collect();

    // Prioritize developer tools at the top of the conflict list
    conflicts.sort_by(|a, b| {
        let a_prio = VERSION_PROBABLE_BINARIES.contains(&a.binary_name.as_str());
        let b_prio = VERSION_PROBABLE_BINARIES.contains(&b.binary_name.as_str());
        match (a_prio, b_prio) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.binary_name.cmp(&b.binary_name),
        }
    });

    if probe_versions {
        // Probing runs the binary itself, so a location inside a world-writable
        // folder is never executed — that is exactly where another account could
        // have planted a program. The conflict is still reported.
        let world_writable: Vec<bool> = entries
            .iter()
            .map(|entry| directory_is_world_writable(&entry.resolved_value))
            .collect();

        // Probe versions in parallel for top developer tool conflicts (up to 16 tools to stay snappy)
        let tasks: Vec<(usize, usize, PathBuf, String)> = conflicts
            .iter()
            .enumerate()
            .filter(|(_, c)| VERSION_PROBABLE_BINARIES.contains(&c.binary_name.as_str()))
            .take(16)
            .flat_map(|(c_idx, c)| {
                c.locations
                    .iter()
                    .enumerate()
                    .filter(|(_, loc)| {
                        !world_writable
                            .get(loc.path_entry_index)
                            .copied()
                            .unwrap_or(true)
                    })
                    .map(move |(l_idx, loc)| (c_idx, l_idx, loc.full_path.clone(), c.binary_name.clone()))
            })
            .collect();

        let results: Arc<Mutex<Vec<(usize, usize, Option<String>)>>> =
            Arc::new(Mutex::new(Vec::with_capacity(tasks.len())));

        std::thread::scope(|s| {
            for (c_idx, l_idx, path, name) in tasks {
                let res_clone = Arc::clone(&results);
                s.spawn(move || {
                    let ver = probe_binary_version(&path, &name);
                    if let Ok(mut guard) = res_clone.lock() {
                        guard.push((c_idx, l_idx, ver));
                    }
                });
            }
        });

        if let Ok(guard) = results.lock() {
            for &(c_idx, l_idx, ref ver) in guard.iter() {
                if let Some(conflict) = conflicts.get_mut(c_idx) {
                    if let Some(loc) = conflict.locations.get_mut(l_idx) {
                        loc.version_hint = ver.clone();
                    }
                }
            }
        };
    }

    conflicts
}

/// List executables inside a specific PathEntry for the Right Inspector Panel
pub fn inspect_directory_executables(
    target_index: usize,
    entries: &[PathEntry],
    conflicts: &[BinaryConflict],
) -> Vec<DirectoryExecutable> {
    let entry = match entries.get(target_index) {
        Some(e) if e.exists => e,
        _ => return Vec::new(),
    };

    let conflict_map: HashMap<&str, &BinaryConflict> = conflicts
        .iter()
        .map(|c| (c.binary_name.as_str(), c))
        .collect();

    let raw_exes = scan_directory_executables(&entry.resolved_value);
    let mut out = Vec::with_capacity(raw_exes.len());

    for (cmd_name, full_path) in raw_exes {
        let mut is_shadowed = false;
        let mut active_path = None;
        let mut version_hint = None;

        if let Some(conflict) = conflict_map.get(cmd_name.as_str()) {
            if let Some(me) = conflict
                .locations
                .iter()
                .find(|l| l.path_entry_index == target_index)
            {
                version_hint = me.version_hint.clone();
                // This directory is only "shadowed" when the same binary also
                // exists earlier in PATH and therefore wins resolution.
                if !me.is_active {
                    is_shadowed = true;
                    active_path = conflict
                        .locations
                        .iter()
                        .find(|l| l.is_active)
                        .map(|l| l.full_path.clone());
                }
            }
        }

        let display_name = full_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(cmd_name);

        out.push(DirectoryExecutable {
            name: display_name,
            full_path,
            version_hint,
            is_shadowed,
            active_path,
        });
    }

    // Sort shadowed or versioned executables first for convenience
    out.sort_by(|a, b| match (a.is_shadowed, b.is_shadowed) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::Scope;

    fn make_entry(id: &str, dir: &Path) -> PathEntry {
        PathEntry {
            id: id.to_string(),
            raw_value: dir.to_string_lossy().to_string(),
            resolved_value: dir.to_path_buf(),
            scope: Scope::System,
            source_text: None,
            exists: dir.is_dir(),
            executable_count: 0,
            issues: vec![],
        }
    }

    fn write_exec(path: &Path) {
        // A command is only executable on Windows when it carries a `PATHEXT`
        // extension. The tests name their stubs without one so the fixtures read
        // the same on every platform; add the extension here instead.
        #[cfg(target_os = "windows")]
        let path = &path.with_extension("exe");
        fs::write(path, "#!/bin/sh\nexit 0\n").expect("write exec");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
    }

    #[test]
    fn session_entries_do_not_create_conflicts() {
        // `npm run` injects `<project>/node_modules/.bin` into the session PATH.
        // If a tool also exists in a config-declared folder, that is not a finding
        // the user can act on — and conflicts cost score, so session entries must
        // not manufacture them. Their executable count is still reported.
        let base = std::env::temp_dir().join(format!("envdoc_scan_{}", uuid::Uuid::new_v4()));
        let dir_a = base.join("a");
        let dir_b = base.join("b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        write_exec(&dir_a.join("mytool"));
        write_exec(&dir_b.join("mytool"));

        let mut entries = vec![
            PathEntry {
                scope: Scope::Process,
                ..make_entry("1", &dir_a)
            },
            make_entry("2", &dir_b),
        ];
        let conflicts = scan_path_and_conflicts(&mut entries, false);

        assert!(
            !conflicts.iter().any(|c| c.binary_name == "mytool"),
            "a session entry must not shadow a config entry"
        );
        assert_eq!(
            entries[0].executable_count, 1,
            "the session directory is still counted for display"
        );

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn detects_shadowing_between_two_distinct_files() {
        let base = std::env::temp_dir().join(format!("envdoc_scan_{}", uuid::Uuid::new_v4()));
        let dir_a = base.join("a");
        let dir_b = base.join("b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        write_exec(&dir_a.join("mytool"));
        write_exec(&dir_b.join("mytool"));

        let mut entries = vec![make_entry("1", &dir_a), make_entry("2", &dir_b)];
        let conflicts = scan_path_and_conflicts(&mut entries, false);

        let conflict = conflicts
            .iter()
            .find(|c| c.binary_name == "mytool")
            .expect("two distinct files named mytool must be a conflict");
        assert_eq!(conflict.locations.len(), 2);
        assert_eq!(entries[0].executable_count, 1);
        assert_eq!(entries[1].executable_count, 1);

        fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn version_probe_never_executes_a_world_writable_binary() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!("envdoc_scan_{}", uuid::Uuid::new_v4()));
        let world = base.join("world");
        let safe = base.join("safe");
        fs::create_dir_all(&world).unwrap();
        fs::create_dir_all(&safe).unwrap();

        // `git` is one of the names the version probe asks for.
        let marker = base.join("executed-by-probe");
        let payload = format!("#!/bin/sh\ntouch '{}'\necho 9.9.9\n", marker.display());
        fs::write(world.join("git"), payload).unwrap();
        fs::set_permissions(world.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&world, fs::Permissions::from_mode(0o777)).unwrap();

        fs::write(safe.join("git"), "#!/bin/sh\necho 1.2.3\n").unwrap();
        fs::set_permissions(safe.join("git"), fs::Permissions::from_mode(0o755)).unwrap();

        let mut entries = vec![make_entry("1", &world), make_entry("2", &safe)];
        let conflicts = scan_path_and_conflicts(&mut entries, true);

        assert!(
            !marker.exists(),
            "a binary inside a world-writable PATH folder must never be executed"
        );
        let conflict = conflicts
            .iter()
            .find(|c| c.binary_name == "git")
            .expect("both folders contain git");
        assert!(
            conflict.locations.iter().any(|loc| loc.version_hint.is_some()),
            "the safe location is still probed"
        );

        let _ = fs::set_permissions(&world, fs::Permissions::from_mode(0o755));
        fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlink_alias_of_same_binary() {
        // `/usr/sbin/ip -> ../bin/ip` (merged-/usr) and `/bin -> /usr/bin` are the
        // same physical binary; they must NOT be reported as shadowing conflicts.
        let base = std::env::temp_dir().join(format!("envdoc_scan_{}", uuid::Uuid::new_v4()));
        let dir_a = base.join("a");
        let dir_b = base.join("b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        let real = dir_a.join("mytool");
        write_exec(&real);
        std::os::unix::fs::symlink(&real, dir_b.join("mytool")).expect("symlink");

        let mut entries = vec![make_entry("1", &dir_a), make_entry("2", &dir_b)];
        let conflicts = scan_path_and_conflicts(&mut entries, false);

        assert!(
            !conflicts.iter().any(|c| c.binary_name == "mytool"),
            "symlink alias of the same inode must not create a shadowing conflict"
        );

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn canonical_directory_alias_is_scanned_once() {
        // Two PATH entries pointing at the same directory via a symlink must be
        // counted as a single physical location (no self-shadowing).
        let base = std::env::temp_dir().join(format!("envdoc_scan_{}", uuid::Uuid::new_v4()));
        let real_dir = base.join("real");
        fs::create_dir_all(&real_dir).unwrap();
        write_exec(&real_dir.join("solo"));

        #[cfg(unix)]
        let alias_dir = {
            let link = base.join("alias");
            std::os::unix::fs::symlink(&real_dir, &link).expect("symlink dir");
            link
        };
        #[cfg(not(unix))]
        let alias_dir = real_dir.clone();

        let mut entries = vec![
            make_entry("1", &real_dir),
            make_entry("2", &alias_dir),
        ];
        let conflicts = scan_path_and_conflicts(&mut entries, false);

        assert!(
            !conflicts.iter().any(|c| c.binary_name == "solo"),
            "an aliased directory must not shadow itself"
        );

        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn active_instance_is_lowest_priority_index() {
        let base = std::env::temp_dir().join(format!("envdoc_scan_{}", uuid::Uuid::new_v4()));
        let dirs: Vec<PathBuf> = (0..3)
            .map(|n| base.join(format!("d{}", n)))
            .inspect(|d| fs::create_dir_all(d).unwrap())
            .collect();
        for d in &dirs {
            write_exec(&d.join("tool"));
        }

        let mut entries: Vec<PathEntry> = dirs
            .iter()
            .enumerate()
            .map(|(i, d)| make_entry(&i.to_string(), d))
            .collect();
        let conflicts = scan_path_and_conflicts(&mut entries, false);

        let conflict = conflicts
            .iter()
            .find(|c| c.binary_name == "tool")
            .expect("tool must be conflicted across 3 directories");
        assert_eq!(conflict.locations.len(), 3);

        // Instances must be ordered by PATH priority with exactly one active,
        // and the active one must be the lowest index (what actually executes).
        let indices: Vec<usize> = conflict.locations.iter().map(|l| l.path_entry_index).collect();
        assert_eq!(indices, vec![0, 1, 2]);
        assert_eq!(
            conflict.locations.iter().filter(|l| l.is_active).count(),
            1,
            "exactly one instance may be active"
        );
        assert!(conflict.locations[0].is_active);
        assert!(!conflict.locations[1].is_active);
        assert!(!conflict.locations[2].is_active);

        // Inspecting a shadowed directory reports it as shadowed with the active
        // path; inspecting the active directory does not.
        let active_view = inspect_directory_executables(0, &entries, &conflicts);
        assert!(active_view.iter().all(|e| !e.is_shadowed));
        let shadowed_view = inspect_directory_executables(2, &entries, &conflicts);
        // The displayed name is the real file name; only Windows stubs carry an
        // extension (see `write_exec`).
        let tool_name = if cfg!(target_os = "windows") {
            "tool.exe"
        } else {
            "tool"
        };
        let tool = shadowed_view
            .iter()
            .find(|e| e.name == tool_name)
            .expect("tool must be listed");
        assert!(tool.is_shadowed);
        let expected_active = fs::canonicalize(&dirs[0]).unwrap().join(tool_name);
        assert_eq!(tool.active_path.as_deref(), Some(expected_active.as_path()));

        fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn counts_every_command_name_in_a_symlink_farm() {
        // Real example: `/snap/bin` holds 11 symlinks that all resolve to
        // `/usr/bin/snap`. They are 11 different commands a user can run, so the
        // reported count must be 11 — while the *same* directory reached through a
        // second PATH entry may still not shadow itself.
        let base = std::env::temp_dir().join(format!("envdoc_scan_{}", uuid::Uuid::new_v4()));
        let dir = base.join("farm");
        fs::create_dir_all(&dir).unwrap();
        let real = base.join("real-binary");
        write_exec(&real);
        for name in ["alpha", "beta", "gamma"] {
            std::os::unix::fs::symlink(&real, dir.join(name)).expect("symlink");
        }

        let exes = scan_directory_executables(&dir);
        assert_eq!(
            exes.len(),
            3,
            "every distinct command name must be counted, got {exes:?}"
        );

        let alias = base.join("alias");
        std::os::unix::fs::symlink(&dir, &alias).expect("symlink dir");
        let mut entries = vec![make_entry("1", &dir), make_entry("2", &alias)];
        let conflicts = scan_path_and_conflicts(&mut entries, false);
        assert_eq!(entries[0].executable_count, 3);
        assert_eq!(entries[1].executable_count, 3);
        assert!(
            conflicts.is_empty(),
            "an aliased directory must not shadow itself, got {conflicts:?}"
        );

        fs::remove_dir_all(&base).ok();
    }
}
