pub mod commands;
pub mod core;
pub mod platform;

use commands::doctor_cmds::{
    check_protected_path, clean_all_paths, get_directory_executables, reanalyze_staged_paths,
    run_full_diagnostics,
};
use commands::env_cmds::{apply_staged_changes, preview_staged_diff, resolve_new_path_entry};
use commands::export_cmds::save_export_file;
use commands::snapshot_cmds::{
    create_manual_snapshot, delete_profile_cmd, delete_snapshot_cmd, export_environment,
    get_profiles, get_snapshot_diff, get_snapshots, restore_snapshot, save_profile_cmd,
};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_linux_webkit_compat();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            // Start background file watcher (`notify`) to detect external configuration changes
            std::thread::spawn(move || {
                let (tx, rx) = std::sync::mpsc::channel();
                let Ok(mut watcher) = RecommendedWatcher::new(tx, Config::default()) else {
                    return;
                };
                let Some(home) = dirs::home_dir() else {
                    return;
                };

                // Watch the *folders* that hold the files we read, not the files
                // themselves: vim, `sed -i` and most installers save by renaming
                // a temporary file over the original, which detaches an inotify
                // watch placed on the old inode. A folder watch keeps working.
                let folders = [
                    home.clone(),
                    home.join(".cargo"),
                    home.join(".config").join("environment.d"),
                    home.join(".config").join("fish"),
                    PathBuf::from("/etc"),
                    PathBuf::from("/etc/profile.d"),
                    PathBuf::from("/etc/environment.d"),
                    PathBuf::from("/usr/lib/environment.d"),
                ];
                for folder in folders.iter().filter(|folder| folder.is_dir()) {
                    let _ = watcher.watch(folder, RecursiveMode::NonRecursive);
                }

                // Files under $HOME that the doctor reads.
                let home_files: HashSet<PathBuf> = [
                    ".profile",
                    ".bash_profile",
                    ".bashrc",
                    ".zshenv",
                    ".zshrc",
                    ".pam_environment",
                    ".cargo/env",
                    ".config/fish/config.fish",
                ]
                .iter()
                .map(|name| home.join(name))
                .collect();
                let system_files: HashSet<PathBuf> = [
                    PathBuf::from("/etc/environment"),
                    PathBuf::from("/etc/profile"),
                ]
                .into_iter()
                .collect();
                let environment_d_folders = [
                    home.join(".config").join("environment.d"),
                    PathBuf::from("/etc/environment.d"),
                    PathBuf::from("/usr/lib/environment.d"),
                ];

                // Folder watches report every sibling file too, so keep only the
                // paths this app actually reads.
                let is_relevant = |path: &Path| {
                    let name = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default();
                    // Our own writes must not be reported as external changes:
                    // `apply_environment` rewrites env.sh and this
                    // environment.d file immediately after the user clicks Apply.
                    if matches!(name, "zz-env-doctor.conf" | "99-env-doctor.conf") {
                        return false;
                    }
                    if home_files.contains(path) || system_files.contains(path) {
                        return true;
                    }
                    match path.parent() {
                        Some(parent) if parent == Path::new("/etc/profile.d") => {
                            name.ends_with(".sh")
                        }
                        Some(parent) if environment_d_folders.iter().any(|f| f == parent) => {
                            name.ends_with(".conf")
                        }
                        _ => false,
                    }
                };

                // A single editor save produces several inotify events; a short
                // debounce keeps one save from stacking up toasts.
                let mut last_emit: Option<std::time::Instant> = None;
                for res in rx {
                    let Ok(event) = res else { continue };
                    if !event.paths.iter().any(|path| is_relevant(path)) {
                        continue;
                    }
                    if last_emit.is_some_and(|at| {
                        at.elapsed() < std::time::Duration::from_millis(750)
                    }) {
                        continue;
                    }
                    last_emit = Some(std::time::Instant::now());
                    let _ = app_handle.emit("env-external-change", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_full_diagnostics,
            reanalyze_staged_paths,
            clean_all_paths,
            get_directory_executables,
            check_protected_path,
            resolve_new_path_entry,
            preview_staged_diff,
            apply_staged_changes,
            get_snapshots,
            create_manual_snapshot,
            delete_snapshot_cmd,
            get_snapshot_diff,
            restore_snapshot,
            get_profiles,
            save_profile_cmd,
            delete_profile_cmd,
            export_environment,
            save_export_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// WebKitGTK 2.42+ renders through an accelerated compositing path backed by the
/// DMA-BUF renderer. On some virtual GPUs (notably VMware's `vmwgfx`) and on
/// hosts without a usable DRM device, that renderer fails silently: the window
/// paints once and then never repaints, so moving or resizing it leaves a blank
/// white surface.
///
/// When such an environment is detected we transparently fall back to WebKit's
/// software renderer. The check is skipped if the user already set
/// `WEBKIT_DISABLE_DMABUF_RENDERER` (any value wins), so the behaviour can always
/// be forced from the outside.
#[cfg(target_os = "linux")]
fn apply_linux_webkit_compat() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }
    if linux_uses_problematic_gpu() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// Detects DRM drivers whose GBM/DMA-BUF support is known to break WebKitGTK's
/// accelerated renderer, or a system with no usable DRM card at all.
#[cfg(target_os = "linux")]
fn linux_uses_problematic_gpu() -> bool {
    const VIRTUAL_GPU_DRIVERS: &[&str] = &[
        "vmwgfx",     // VMware SVGA
        "qxl",        // SPICE
        "vboxvideo",  // VirtualBox
        "cirrus",     // QEMU cirrus
        "bochs-drm",  // QEMU stdvga
        "vgem",       // virtual GEM
    ];

    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        // No DRM subsystem at all: DMA-BUF cannot work here.
        return true;
    };

    let mut found_card = false;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Match `card0`, `card1`, ... but not connectors such as `card0-DP-1`.
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        found_card = true;

        let driver_link = entry.path().join("device/driver");
        if let Ok(target) = std::fs::read_link(&driver_link) {
            if let Some(driver) = target.file_name().and_then(|d| d.to_str()) {
                if VIRTUAL_GPU_DRIVERS.contains(&driver) {
                    return true;
                }
            }
        }
    }

    // No usable DRM card node -> WebKit cannot use the DMA-BUF renderer.
    !found_card
}
