#![cfg(target_os = "windows")]

use crate::core::doctor::{expand_path_variables, is_core_system_bin_dir};
use crate::core::{EnvVariable, OsContext, PathEntry, Scope};
use crate::platform::PlatformEnvManager;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use uuid::Uuid;
use winreg::enums::{RegType, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
use winreg::{RegKey, RegValue};

const HKCU_ENV_PATH: &str = "Environment";
const HKLM_ENV_PATH: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

pub struct WindowsEnvManager;

impl WindowsEnvManager {
    pub fn new() -> Self {
        Self
    }

    fn decode_reg_value(val: &RegValue) -> Option<(String, bool)> {
        let is_expand = val.vtype == RegType::REG_EXPAND_SZ;
        if val.bytes.is_empty() {
            return Some((String::new(), is_expand));
        }
        // Decode UTF-16LE bytes
        let u16_slice: Vec<u16> = val
            .bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let mut s = String::from_utf16_lossy(&u16_slice);
        while s.ends_with('\0') {
            s.pop();
        }
        Some((s, is_expand))
    }

    /// Effective registry kind for a value.
    ///
    /// A value containing `%` is always written as `REG_EXPAND_SZ`: storing a
    /// path such as `%SystemRoot%\...` as `REG_SZ` would make Windows treat the
    /// percent signs literally. The comparison before a write and the encoder
    /// must agree on this, otherwise an unchanged value looks different after
    /// every Apply.
    fn is_expandable_reg_value(text: &str, is_expandable: bool) -> bool {
        is_expandable || text.contains('%')
    }

    fn encode_reg_value(text: &str, is_expandable: bool) -> RegValue {
        let vtype = if Self::is_expandable_reg_value(text, is_expandable) {
            RegType::REG_EXPAND_SZ
        } else {
            RegType::REG_SZ
        };
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let bytes: Vec<u8> = wide.into_iter().flat_map(|w| w.to_le_bytes()).collect();
        RegValue { bytes, vtype }
    }

    fn check_is_elevated() -> bool {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        hklm.open_subkey_with_flags(HKLM_ENV_PATH, KEY_WRITE)
            .is_ok()
    }

    /// The real Windows release and version, read from the registry.
    ///
    /// The registry keeps reporting `ProductName` as "Windows 10 ..." on
    /// Windows 11, so the build number decides the release: 22000 and above is
    /// Windows 11. A hard-coded "Windows 11" would put a wrong system name into
    /// every report on a Windows 10 or Server machine.
    fn windows_version() -> (String, String) {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let mut product = String::new();
        let mut display_version = String::new();
        let mut build = String::new();

        if let Ok(key) = hklm.open_subkey_with_flags(
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
            KEY_READ,
        ) {
            for item in key.enum_values().flatten() {
                let (name, reg_val) = item;
                let Some((text, _)) = Self::decode_reg_value(&reg_val) else {
                    continue;
                };
                match name.as_str() {
                    "ProductName" => product = text,
                    "DisplayVersion" => display_version = text,
                    "CurrentBuildNumber" => build = text,
                    _ => {}
                }
            }
        }

        let build_number: u32 = build.trim().parse().unwrap_or(0);
        let os_name = if let Some(detail) = product.strip_prefix("Windows 10 ") {
            let detail = detail.trim();
            if build_number >= 22000 {
                if detail.is_empty() {
                    "Windows 11".to_string()
                } else {
                    format!("Windows 11 {}", detail)
                }
            } else {
                product.clone()
            }
        } else if product.is_empty() {
            if build_number >= 22000 {
                "Windows 11".to_string()
            } else {
                "Windows".to_string()
            }
        } else {
            product.clone()
        };

        let mut os_version = String::new();
        let display = display_version.trim();
        if !display.is_empty() {
            os_version.push_str(display);
        }
        if build_number > 0 {
            if !os_version.is_empty() {
                os_version.push(' ');
            }
            os_version.push_str(&format!("(build {})", build_number));
        }
        if os_version.is_empty() {
            os_version = std::env::consts::OS.to_string();
        }

        (os_name, os_version)
    }

    /// Broadcast `WM_SETTINGCHANGE` with `"Environment"` so Explorer and terminals reload immediately (Section 3.1.3)
    pub fn broadcast_wm_settingchange() -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };

        let env_wide: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result: usize = 0;

        let ret = unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                env_wide.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result as *mut usize,
            )
        };
        ret != 0
    }

    /// Elevate via PowerShell UAC helper when HKLM modification is requested by a non-elevated user (Section 3.1.4)
    fn apply_system_via_uac_helper(
        // `None` when the staged state describes only System variables and must
        // not rewrite the machine PATH at all.
        sys_path_joined: Option<&str>,
        sys_vars: &[&EnvVariable],
        deleted_sys_keys: &[String],
    ) -> Result<(), String> {
        let mut script_lines = Vec::new();
        script_lines.push("$ErrorActionPreference = 'Stop'".to_string());
        script_lines.push(format!(
            "$regPath = 'HKLM:\\{}'",
            HKLM_ENV_PATH
        ));

        if let Some(sys_path_joined) = sys_path_joined {
            let escaped_path = sys_path_joined.replace('\'', "''");
            let path_kind = if Self::is_expandable_reg_value(sys_path_joined, false) {
                "ExpandString"
            } else {
                "String"
            };
            script_lines.push(format!(
                "Set-ItemProperty -Path $regPath -Name 'Path' -Value '{}' -Type {}",
                escaped_path, path_kind
            ));
        }

        for var in sys_vars {
            let k = var.key.replace('\'', "''");
            let v = var.value.replace('\'', "''");
            let kind = if Self::is_expandable_reg_value(&var.value, var.is_expandable) {
                "ExpandString"
            } else {
                "String"
            };
            script_lines.push(format!(
                "Set-ItemProperty -Path $regPath -Name '{}' -Value '{}' -Type {}",
                k, v, kind
            ));
        }

        for del_key in deleted_sys_keys {
            let k = del_key.replace('\'', "''");
            script_lines.push(format!(
                "Remove-ItemProperty -Path $regPath -Name '{}' -ErrorAction SilentlyContinue",
                k
            ));
        }

        let temp_dir = std::env::temp_dir();
        let script_file = temp_dir.join(format!("env_doctor_uac_{}.ps1", Uuid::new_v4()));
        std::fs::write(&script_file, script_lines.join("\r\n"))
            .map_err(|e| format!("Failed to create temporary UAC script: {}", e))?;

        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"{}\"' -Verb RunAs -Wait",
                    script_file.display()
                ),
            ])
            .status();

        let _ = std::fs::remove_file(&script_file);

        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("UAC elevation helper exited with code {:?}.", s.code())),
            Err(e) => Err(format!("Failed to launch UAC elevation helper: {}", e)),
        }
    }
}

impl PlatformEnvManager for WindowsEnvManager {
    fn load_environment(&self) -> Result<(Vec<PathEntry>, Vec<EnvVariable>, OsContext), String> {
        // Build lookup map of current process environment variables for `%VAR%` resolution
        let mut env_lookup: HashMap<String, String> = HashMap::new();
        for (k, v) in crate::core::unicode_env_vars() {
            env_lookup.insert(k.to_uppercase(), v);
        }

        let mut variables: Vec<EnvVariable> = Vec::new();
        let mut path_entries: Vec<PathEntry> = Vec::new();

        // 1. Read System Environment (HKLM)
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let mut raw_system_path = String::new();
        if let Ok(sys_env) = hklm.open_subkey_with_flags(HKLM_ENV_PATH, KEY_READ) {
            for item in sys_env.enum_values().flatten() {
                let (name, reg_val) = item;
                if let Some((val_str, is_expand)) = Self::decode_reg_value(&reg_val) {
                    env_lookup
                        .entry(name.to_uppercase())
                        .or_insert_with(|| val_str.clone());
                    if name.eq_ignore_ascii_case("Path") {
                        raw_system_path = val_str;
                    } else {
                        variables.push(EnvVariable {
                            key: name,
                            value: val_str,
                            is_expandable: is_expand,
                            scope: Scope::System,
                            is_modified: false,
                        });
                    }
                }
            }
        }

        // 2. Read User Environment (HKCU)
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut raw_user_path = String::new();
        if let Ok(usr_env) = hkcu.open_subkey_with_flags(HKCU_ENV_PATH, KEY_READ) {
            for item in usr_env.enum_values().flatten() {
                let (name, reg_val) = item;
                if let Some((val_str, is_expand)) = Self::decode_reg_value(&reg_val) {
                    env_lookup.insert(name.to_uppercase(), val_str.clone());
                    if name.eq_ignore_ascii_case("Path") {
                        raw_user_path = val_str;
                    } else {
                        variables.push(EnvVariable {
                            key: name,
                            value: val_str,
                            is_expandable: is_expand,
                            scope: Scope::User,
                            is_modified: false,
                        });
                    }
                }
            }
        }

        // 3. Read Process-only variables (variables in std::env::vars not in User/System)
        let known_keys: HashSet<String> = variables
            .iter()
            .map(|v| v.key.to_uppercase())
            .collect();
        for (k, v) in crate::core::unicode_env_vars() {
            if k.eq_ignore_ascii_case("Path") || known_keys.contains(&k.to_uppercase()) {
                continue;
            }
            variables.push(EnvVariable {
                key: k,
                value: v.clone(),
                is_expandable: v.contains('%'),
                scope: Scope::Process,
                is_modified: false,
            });
        }

        variables.sort_by(|a, b| a.key.to_lowercase().cmp(&b.key.to_lowercase()));

        // Parse System PATH entries first (Windows resolves System PATH before User PATH)
        for (idx, part) in raw_system_path
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .enumerate()
        {
            let resolved = expand_path_variables(part, &env_lookup);
            let exists = resolved.exists() && resolved.is_dir();
            path_entries.push(PathEntry {
                id: format!("sys-{}-{}", idx, Uuid::new_v4()),
                raw_value: part.to_string(),
                resolved_value: resolved,
                scope: Scope::System,
                source_text: None,
                exists,
                executable_count: 0,
                issues: Vec::new(),
            });
        }

        // Parse User PATH entries
        for (idx, part) in raw_user_path
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .enumerate()
        {
            let resolved = expand_path_variables(part, &env_lookup);
            let exists = resolved.exists() && resolved.is_dir();
            path_entries.push(PathEntry {
                id: format!("usr-{}-{}", idx, Uuid::new_v4()),
                raw_value: part.to_string(),
                resolved_value: resolved,
                scope: Scope::User,
                source_text: None,
                exists,
                executable_count: 0,
                issues: Vec::new(),
            });
        }

        let total_path_length: usize = path_entries
            .iter()
            .map(|p| p.raw_value.len() + 1)
            .sum();

        let home_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\Users\\Default"))
            .to_string_lossy()
            .to_string();

        let (os_name, os_version) = Self::windows_version();
        let os_context = OsContext {
            os_name,
            os_version,
            arch: std::env::consts::ARCH.to_string(),
            total_path_length,
            max_path_length: 4095,
            is_elevated: Self::check_is_elevated(),
            shell: "PowerShell / CMD (Win32 Registry)".to_string(),
            home_dir,
        };

        Ok((path_entries, variables, os_context))
    }

    fn apply_environment(
        &self,
        path_entries: &[PathEntry],
        variables: &[EnvVariable],
        allow_uac_elevation: bool,
    ) -> Result<(bool, Vec<String>), String> {
        // Section 9.1 Safe Guard: Verify the core system directory is still
        // present if the staged state describes the System PATH. Keeping only
        // `C:\Windows` (or any other protected folder) is not enough: without
        // System32 a new shell cannot resolve the operating system's commands.
        let has_system_entries = path_entries.iter().any(|p| p.scope == Scope::System);
        if has_system_entries {
            let has_system32 = path_entries
                .iter()
                .filter(|p| p.scope == Scope::System)
                .any(|p| is_core_system_bin_dir(&p.raw_value, &p.resolved_value));
            if !has_system32 {
                return Err(
                    "Safe Guard: Critical Windows system path (C:\\Windows\\System32) is missing; operation blocked."
                        .to_string(),
                );
            }
        }

        let mut warnings = Vec::new();

        // The registry's `Path` value is written from the PATH entries below. A
        // variable row named `Path` (imported, or added by hand) is filtered out
        // by that logic, so report it instead of dropping it silently.
        let ignored_path_variables = variables
            .iter()
            .filter(|v| v.scope != Scope::Process && v.key.eq_ignore_ascii_case("Path"))
            .count();
        if ignored_path_variables > 0 {
            warnings.push(format!(
                "Left out {} variable row named `Path`: the PATH is written from the PATH entries, not from a variable. Edit it in the PATH editor instead.",
                ignored_path_variables
            ));
        }

        // 1. Apply User PATH & User Variables to HKCU\Environment
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let usr_env = hkcu
            .open_subkey_with_flags(HKCU_ENV_PATH, KEY_READ | KEY_WRITE)
            .map_err(|e| format!("Failed to open HKCU\\Environment registry key: {}", e))?;

        let user_paths: Vec<&str> = path_entries
            .iter()
            .filter(|p| p.scope == Scope::User)
            .map(|p| p.raw_value.trim())
            .filter(|s| !s.is_empty())
            .collect();
        let user_path_joined = user_paths.join(";");

        // Preserve REG_EXPAND_SZ when % is present (Section 3.1.2)
        let user_path_reg = Self::encode_reg_value(&user_path_joined, user_path_joined.contains('%'));
        usr_env
            .set_raw_value("Path", &user_path_reg)
            .map_err(|e| format!("Failed to write User Path: {}", e))?;

        // Track existing user variable keys to delete removed ones
        let existing_user_keys: Vec<String> = usr_env
            .enum_values()
            .flatten()
            .map(|(k, _)| k)
            .filter(|k| !k.eq_ignore_ascii_case("Path"))
            .collect();

        let new_user_vars: Vec<&EnvVariable> = variables
            .iter()
            .filter(|v| v.scope == Scope::User && !v.key.eq_ignore_ascii_case("Path"))
            .collect();

        let new_user_key_set: HashSet<String> = new_user_vars
            .iter()
            .map(|v| v.key.to_uppercase())
            .collect();

        for old_k in existing_user_keys {
            if !new_user_key_set.contains(&old_k.to_uppercase()) {
                let _ = usr_env.delete_value(&old_k);
            }
        }

        for var in &new_user_vars {
            let reg_val = Self::encode_reg_value(&var.value, var.is_expandable);
            usr_env
                .set_raw_value(&var.key, &reg_val)
                .map_err(|e| format!("Failed to save User variable '{}': {}", var.key, e))?;
        }

        // 2. Check if System PATH or System Variables changed compared to current HKLM
        let sys_paths: Vec<&str> = path_entries
            .iter()
            .filter(|p| p.scope == Scope::System)
            .map(|p| p.raw_value.trim())
            .filter(|s| !s.is_empty())
            .collect();
        let sys_path_joined = sys_paths.join(";");

        let new_sys_vars: Vec<&EnvVariable> = variables
            .iter()
            .filter(|v| v.scope == Scope::System && !v.key.eq_ignore_ascii_case("Path"))
            .collect();

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        // If the staged state contains no System-scoped element at all, it does
        // not describe the machine-wide environment (an import from Linux has
        // only Dotfile scopes, and a failed scan can leave the scope out). Do
        // not interpret that absence as "delete every HKLM variable and PATH";
        // a real Windows scan always contributes System PATH entries, so an
        // intentional System change still has a scope marker here.
        let has_staged_system_paths = path_entries
            .iter()
            .any(|p| p.scope == Scope::System);
        let has_staged_system_scope = has_staged_system_paths
            || variables.iter().any(|v| v.scope == Scope::System);
        // System *variables* alone must not rewrite the machine PATH: without a
        // staged path list there is nothing to compare, and treating the empty
        // list as a change would blank `HKLM\...\Environment\Path`.
        let describes_system_path = has_staged_system_paths && !sys_paths.is_empty();
        if !has_staged_system_scope {
            // Leave HKLM untouched.
        } else if let Ok(sys_env_read) = hklm.open_subkey_with_flags(HKLM_ENV_PATH, KEY_READ) {
            let mut current_sys_path = String::new();
            // Registry value names are case-insensitive, so keep the original
            // spelling together with the decoded value and compare by uppercase
            // name. Comparing raw keys would report a change (and trigger UAC)
            // when a staged key only differs in letter case.
            let mut current_sys_vars: HashMap<String, (String, bool)> = HashMap::new();

            for item in sys_env_read.enum_values().flatten() {
                let (k, reg_val) = item;
                if let Some((v, is_expand)) = Self::decode_reg_value(&reg_val) {
                    if k.eq_ignore_ascii_case("Path") {
                        current_sys_path = v;
                    } else {
                        current_sys_vars.insert(k, (v, is_expand));
                    }
                }
            }

            let cur_sys_norm: Vec<&str> = current_sys_path
                .split(';')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            let sys_path_changed = describes_system_path && cur_sys_norm != sys_paths;

            let new_sys_map: HashMap<String, (String, bool)> = new_sys_vars
                .iter()
                .map(|v| {
                    (
                        v.key.to_uppercase(),
                        (
                            v.value.clone(),
                            Self::is_expandable_reg_value(&v.value, v.is_expandable),
                        ),
                    )
                })
                .collect();
            let current_sys_map: HashMap<String, (String, bool)> = current_sys_vars
                .iter()
                .map(|(k, (value, is_expand))| (k.to_uppercase(), (value.clone(), *is_expand)))
                .collect();
            // The value's text and its registry type both matter: flipping a
            // System variable from REG_SZ to REG_EXPAND_SZ (or back) must be
            // written too, otherwise a value stored with the wrong kind is
            // never corrected.
            let sys_vars_changed = current_sys_map != new_sys_map;

            if sys_path_changed || sys_vars_changed {
                let deleted_sys_keys: Vec<String> = current_sys_vars
                    .keys()
                    .filter(|k| !new_sys_map.contains_key(&k.to_uppercase()))
                    .cloned()
                    .collect();

                match hklm.open_subkey_with_flags(HKLM_ENV_PATH, KEY_READ | KEY_WRITE) {
                    Ok(sys_env_write) => {
                        if describes_system_path {
                            let sys_path_reg = Self::encode_reg_value(
                                &sys_path_joined,
                                sys_path_joined.contains('%'),
                            );
                            sys_env_write
                                .set_raw_value("Path", &sys_path_reg)
                                .map_err(|e| format!("Failed to write System Path: {}", e))?;
                        }

                        for del_k in &deleted_sys_keys {
                            let _ = sys_env_write.delete_value(del_k);
                        }
                        for var in &new_sys_vars {
                            let reg_val = Self::encode_reg_value(&var.value, var.is_expandable);
                            sys_env_write
                                .set_raw_value(&var.key, &reg_val)
                                .map_err(|e| format!("Failed to save System variable '{}': {}", var.key, e))?;
                        }
                    }
                    Err(_) => {
                        if allow_uac_elevation {
                            Self::apply_system_via_uac_helper(
                                describes_system_path.then_some(sys_path_joined.as_str()),
                                &new_sys_vars,
                                &deleted_sys_keys,
                            )?;
                        } else {
                            warnings.push(
                                "System (HKLM) variables require administrator privileges (UAC); only User (HKCU) changes were applied."
                                    .to_string(),
                            );
                        }
                    }
                }
            }
        }

        // 3. Broadcast WM_SETTINGCHANGE
        let broadcasted = Self::broadcast_wm_settingchange();
        Ok((broadcasted, warnings))
    }
}
