use serde::Serialize;
use std::path::Path;

/// Result of writing an exported report to disk.
#[derive(Debug, Clone, Serialize)]
pub struct ExportFileOutcome {
    pub path: String,
    pub bytes: usize,
}

/// Write report text to a location the user chose in the native save dialog.
///
/// The report body is rendered on the frontend so the exported wording matches
/// the UI exactly; this command only performs the write. Keeping the write here
/// avoids granting the frontend blanket filesystem access.
fn write_text_file(path: &str, contents: &str) -> Result<ExportFileOutcome, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No destination was chosen for the export.".to_string());
    }

    let target = Path::new(trimmed);
    if !target.is_absolute() {
        return Err(format!(
            "Refusing to write the export to a relative path: {}",
            trimmed
        ));
    }
    if target.is_dir() {
        return Err(format!("{} is a directory, not a file.", trimmed));
    }
    // Refuse device nodes, sockets and FIFOs: writing to a FIFO with no reader
    // would block the export forever, and a device node would silently swallow
    // the report.
    if let Ok(metadata) = std::fs::metadata(target) {
        if !metadata.is_file() {
            return Err(format!("{} is not a regular file.", trimmed));
        }
    }

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
        }
    }

    std::fs::write(target, contents.as_bytes())
        .map_err(|e| format!("Could not write {}: {}", target.display(), e))?;

    Ok(ExportFileOutcome {
        path: target.display().to_string(),
        bytes: contents.len(),
    })
}

#[tauri::command]
pub fn save_export_file(path: String, contents: String) -> Result<ExportFileOutcome, String> {
    write_text_file(&path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "env-doctor-export-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_contents_and_reports_byte_count() {
        let dir = scratch_dir("write");
        let file = dir.join("report.md");
        let body = "# Report\n\nhello ✅\n";

        let outcome = write_text_file(file.to_str().unwrap(), body).expect("write should succeed");

        assert_eq!(outcome.bytes, body.len());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), body);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = scratch_dir("mkdir");
        let file = dir.join("nested").join("deeper").join("report.json");

        write_text_file(file.to_str().unwrap(), "{}").expect("write should succeed");

        assert!(file.exists(), "parent directories should be created");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_empty_relative_and_directory_targets() {
        assert!(write_text_file("   ", "x").is_err());
        assert!(write_text_file("relative/report.md", "x").is_err());

        let dir = scratch_dir("dir-target");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(write_text_file(dir.to_str().unwrap(), "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
