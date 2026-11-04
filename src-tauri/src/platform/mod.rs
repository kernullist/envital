#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(target_os = "windows"))]
pub mod linux;

// Also compile linux dotfiles parser module for cross-platform unit testing & reference
#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub mod linux;

use crate::core::{EnvVariable, OsContext, PathEntry};

pub trait PlatformEnvManager: Send + Sync {
    /// Load all PATH entries, environment variables, and OS context from the underlying platform
    fn load_environment(&self) -> Result<(Vec<PathEntry>, Vec<EnvVariable>, OsContext), String>;

    /// Persist staged PATH entries and environment variables to the OS and broadcast reload
    fn apply_environment(
        &self,
        path_entries: &[PathEntry],
        variables: &[EnvVariable],
        allow_uac_elevation: bool,
    ) -> Result<(bool, Vec<String>), String>;
}

pub fn get_platform_manager() -> Box<dyn PlatformEnvManager> {
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsEnvManager::new())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(linux::LinuxEnvManager::new())
    }
}
