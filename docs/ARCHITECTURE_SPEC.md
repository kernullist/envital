# Env & PATH Doctor - System Architecture & Detailed Design Specification

- **Document Version:** v1.0.0
- **Target Platforms:** Windows 10/11 (x64, ARM64), Linux (Ubuntu, Fedora, Arch, and major distributions - X11/Wayland)
- **Recommended Tech Stack:** Tauri v2 (Rust Backend) + React / TypeScript (Frontend) + Tailwind CSS + SQLite

---

## 1. Project Overview

### 1.1 Background & Purpose
Traditional environment variable editors (Windows built-in editor, PowerToys, RapidEE, etc.) only provide basic key-value text editing. The real problems developers face are: **"Why is the program I installed (`python`, `node`, `java`) running an older version (Binary Shadowing)?"** or **"On Linux, which configuration file and which exact line added this `PATH` entry (Dotfile Tracing)?"**

**Env & PATH Doctor** goes beyond simple editing: it is a cross-platform GUI tool that diagnoses the health of environment variables and `PATH`, visualizes priority conflicts, and safely rolls back to any previous state in one click.

### 1.2 Core Value Propositions
1. **Binary Shadowing Detection:** Detects priority conflicts among identically named executables in `PATH` and resolves them via drag-and-drop.
2. **Linux Dotfiles Reverse Tracing:** Traces the exact file path and line number where variables are declared or modified across fragmented configuration files (`/etc/profile`, `~/.bashrc`, `~/.zshrc`, etc.).
3. **PATH Health Check & Cleaning:** Cleans up non-existent directories (Dead Path), duplicate entries (Duplicate), and collapsible home paths (`%USERPROFILE%`, `$HOME`) in one click.
4. **Time-Machine Snapshots (Rollback):** Automatically records before/after states in a local SQLite database, compares changes in Git Diff style, and restores any snapshot in 1 second.

---

## 2. System Architecture

```
+-----------------------------------------------------------------------+
|                        Frontend (WebView / UI)                        |
|  [Dashboard & Doctor]  [PATH Drag Editor]  [Conflict Sim]  [Diff TM]  |
+-----------------------------------+-----------------------------------+
                                    | Tauri IPC (Typed JSON Commands)
+-----------------------------------v-----------------------------------+
|                         Backend Core (Rust)                           |
|  +-----------------+  +--------------------+  +--------------------+  |
|  |  Doctor Engine  |  |  Shadowing Scanner |  |  Snapshot Manager  |  |
|  | (Path/Syntax)   |  | (Duplicate Binary) |  |  (SQLite + Diff)   |  |
|  +-----------------+  +--------------------+  +--------------------+  |
|                                   |                                   |
|  +--------------------------------v--------------------------------+  |
|  |              OS Abstraction Layer (Platform Trait)              |  |
|  +-------------------------------+---------------------------------+  |
|                                  |                                    |
|         +------------------------+------------------------+           |
|         | Windows Adapter                                 | Linux Adapter
|  +------v-------------------------+   +-------------------v--------+  |
|  | - Win32 Registry (HKCU / HKLM) |   | - Shell Tracer (bash/zsh)  |  |
|  | - WM_SETTINGCHANGE Broadcast   |   | - Dotfiles AST/Regex Parser|  |
|  | - UAC Elevation Helper         |   | - systemd environment.d    |  |
|  +--------------------------------+   +----------------------------+  |
+-----------------------------------------------------------------------+
```

### 2.1 Tech Stack Details
* **Core Framework:** **Tauri v2** (Maintains memory footprint under 30MB, provides native OS filesystem and registry access)
* **Backend (Rust):**
  * `winreg`: Read/write Windows Registry (`HKCU`, `HKLM`)
  * `windows-sys`: Broadcast `WM_SETTINGCHANGE` messages via Win32 API
  * `rusqlite`: Local storage for Time-Machine snapshots and change history
  * `similar`: Textual and structural Diff calculation between snapshots
  * `notify`: Real-time detection of external changes to the scanned configuration files on Linux (the app rescans on demand elsewhere, and registry edits are picked up by the next scan/Refresh)
* **Frontend (TypeScript):**
  * **React 19 + Vite**
  * **@dnd-kit:** Smooth drag-and-drop for reordering `PATH` priority
  * **Zustand:** Frontend global state and Undo/Redo stack management
  * **Tailwind CSS + shadcn/ui:** Modern, intuitive dark UI (a single palette keeps contrast predictable in the WebKitGTK webview)

---

## 3. OS-Specific Environment Variable Control Mechanisms (OS Adapters)

Because Windows and Linux handle environment variables with fundamentally different philosophies, a Rust `Trait` unifies the interface while isolating platform-specific implementations.

### 3.1 Windows Adapter
1. **Data Sources:**
   * **User Variables (User):** `HKEY_CURRENT_USER\Environment`
   * **System Variables (System):** `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
   * **Process/Session Variables:** Current execution context, read with `std::env::vars_os()` so a non-UTF-8 value cannot abort the scan
2. **Type Preservation (Critical):**
   * Strictly distinguish between `REG_SZ` (plain string) and `REG_EXPAND_SZ` (expandable string such as `%SystemRoot%`) when reading and writing registry values. Saving a path containing `%` as `REG_SZ` causes a critical bug where Windows fails to resolve the path.
3. **Immediate Reload (Hot Reload):**
   * Call Win32 API `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", ...)` after registry updates so Explorer and new terminal sessions reflect changes without rebooting.
4. **Privilege Separation:**
   * Invoke a lightweight UAC elevation helper only when modifying System variables (`HKLM`), allowing the main GUI application to run safely with standard user privileges.

### 3.2 Linux Adapter
Linux has no single registry; instead, multiple files are sourced sequentially to construct environment variables. To solve this, a **"2-Way Hybrid Strategy"** is used.

1. **Step 1: Reverse Origin Tracing (Read & Trace)**
   * **Static File Scan:** Parse standard configuration files for `export VAR=...` and `PATH=...` statements along with line numbers:
     * System-wide: `/etc/environment`, `/etc/profile`, `/etc/profile.d/*.sh`, `/etc/environment.d/*.conf`
     * systemd user session: `/usr/lib/environment.d/*.conf` (this is where snapd appends `/snap/bin`, which is why that folder can appear twice)
     * GUI/Systemd Session: `~/.config/environment.d/*.conf`, `~/.pam_environment`
     * Shell Configs (Bash/Zsh/Fish): `~/.profile`, `~/.bashrc`, `~/.bash_profile`, `~/.zshenv`, `~/.zshrc`, `~/.config/fish/config.fish`
     * Tool managers: `~/.cargo/env` (rustup prepends `$HOME/.cargo/bin` here, not in `.bashrc`)
   * Candidate files are de-duplicated by canonical path, so a symlinked alias (`/usr/lib/environment.d/99-environment.conf` → `/etc/environment`) is cited under the name a user would actually edit.
   * **Files the app writes itself are not user configuration.** `~/.config/environment.d/zz-env-doctor.conf` is excluded from the source scan entirely (it only mirrors `env.sh`). `~/.config/env-doctor/env.sh` is still read so variables added or edited in the app survive a restart, but its `PATH` declarations are appended *after* every real source: a folder that `.bashrc` also declares keeps pointing at `.bashrc`, and only app-added folders are attributed to `env.sh`. Entries attributed to the generated file are never reported as `UNEXPANDED`, because the app wrote them from live values rather than from typed text.
   * **Per-occurrence attribution:** each declared fragment is stored with the file/line that declared it, **in scan order**. When a fragment is declared more than once, the *n*-th occurrence in `PATH` is attributed to the *n*-th declaration. This is what lets the report say "this second `/snap/bin` comes from `/usr/lib/environment.d/990-snapd.conf`" instead of blaming one file for both copies.
   * **Double-quoted declarations are expanded:** the parser keeps the value as written, so `PATH="$HOME/.local/bin:$PATH"` is held as text while the live `PATH` holds `/home/dev/.local/bin` (this is the stock Debian/Ubuntu `~/.profile` block). A double-quoted value is expanded the way a POSIX shell expands it inside double quotes (`$VAR`, `${VAR}`, a leading `~` and a `~` after `:`), so the folder stays attributed to the file that declared it instead of becoming an unattributed session entry. Single-quoted and unquoted values are literal and are left alone, and only the simple form is modelled — `${VAR:-default}`, `${VAR%%.*}` and command substitution are left verbatim rather than guessed at. The scope of such an entry carries `expanded: true`, and Apply writes the resolved directory as data for it: the declaring text is a template for the shell that read it, so replaying it could expand to a different folder in the shell that sources `env.sh`.
   * **Session classification:** a `PATH` entry that no configuration file declares is scoped `Process` (badge `PROC`) rather than being guessed as `User`/`System` from its location. `Process` entries carry no issues and are excluded from the health score, because runtime injections (`npm`'s `node_modules/.bin` chain, `node-gyp-bin`, a shell's tool-manager bin folder) are not the user's configuration. They are still listed in the UI and the report so the effective `PATH` is complete.
   * **Environment variables vs. shell locals:** only declarations that actually reach the environment are recorded: `export KEY=...`, fish's `set -gx KEY ...`, a later bare `export KEY` (`/etc/profile.d/xdg_dirs_desktop_session.sh`), or any assignment in an *environment-style* file (`/etc/environment`, `environment.d/*.conf`) where a bare `KEY=value` **is** the declaration. `~/.pam_environment` uses pam_env's own `KEY [DEFAULT=]value` syntax and is read by a dedicated parser. A plain `key=value` in a shell script is a local (except `PATH`, which the login environment already exports, so even a bare `PATH=...` reaches child processes), so it is not listed — otherwise `key`, `val`, `prefix`, `bad_kv`, … from `/etc/profile.d/*.sh` inflated the variable count and showed up as unmatchable noise in the Variables view. For example, on a typical desktop system that reduces 36 declared names to 9 real environment variables.
   * **Dynamic Shell Tracing:** When tools such as `nvm`, `pyenv`, or `conda` dynamically generate `PATH`, run `zsh -xlc "env"` or `bash -xlc "env"` with a short timeout, drain the `set -x` trace from stderr while the shell runs (a full pipe would otherwise block it), and parse that trace to map which script contributed the *newly added* fragments (a re-assignment of the whole `PATH` does not re-credit the base folders). The timeout keeps a profile that prompts or waits on the network from blocking the scan, and therefore Apply and Restore too; a partial trace is still usable.
2. **Step 2: Safe Writing (Managed Block Strategy)**
   * Blindly modifying complex conditional blocks (`if-else`) inside a user's `.bashrc` from a GUI can corrupt the script.
   * **Solution:** Support simple line edits while defaulting to generating `~/.config/env-doctor/env.sh` and injecting a single **Managed Block** at the end of `.bashrc`, `.zshrc` and `.profile` (the last one covers non-interactive login shells such as `ssh host cmd`, where bash's `.bashrc` returns early). The block uses the POSIX `.` builtin so it also works when `~/.profile` is read by `dash`:
     ```bash
     # >>> env-doctor initialize >>>
     [ -f "$HOME/.config/env-doctor/env.sh" ] && . "$HOME/.config/env-doctor/env.sh"
     # <<< env-doctor initialize <<<
     ```
     Only rc files that already exist are touched (creating an unrelated `.zshrc` for a bash user would be noise). An Apply that finds neither `~/.bashrc` nor `~/.zshrc` reports that interactive shells have no loader block, instead of succeeding silently.
   * `env.sh` can contain variable values, so it is written with mode `0600`. GUI sessions read the same `PATH` from `~/.config/environment.d/zz-env-doctor.conf`; the `zz-` prefix makes it the final assignment, after `990-snapd.conf` (which only appends `/snap/bin`).
   * **Deleting a declared variable:** a variable read from the user's own dotfile cannot be deleted from the Variables view. Apply only writes `env.sh` and emits no `unset`, so the original `export` in `.bashrc` would keep running and the row would reappear on the next scan; the delete action is disabled and the file itself is the place to remove it. Editing the value still works, because `env.sh` is sourced after the profile.
   * **What is written back:** the declared entries plus the *tool* session entries (a live `~/.nvm/.../bin` must survive or `node` disappears from new shells). Each `export` line is shell-quoted: literal user-typed values are single-quoted (so `$5` cannot expand to nothing and a trailing `\` cannot escape the closing quote), while config-derived values stay in double quotes with backslashes escaped so `${VAR:-…}`, `$(…)` and a leading `~` keep their original meaning. The quote style is also how the next scan knows a saved value was literal: `pa$$` is re-read as text, not as the shell PID. The same rule applies to the user's own files: a value the user wrote as `export TOKEN='pa$$word'` is single-quoted, so it is never written back as `"pa$$word"` — which would expand `$$` to the process id in every new shell. Quotes and escapes decide the intent, not the characters in the value: `export A="\$HOME"` and `export A="~/bin"` are literals, while `export A=$HOME` and `export A=~/bin` stay templates. The joined `PATH` is written as data rather than a template: only the `$HOME`/`${HOME}` form produced by Clean All stays expandable, while `$(…)`, backticks and other `$` forms are escaped, so a PATH entry (including an imported one) cannot run a command when a shell sources the file. An entry whose source was a double-quoted declaration (`PATH="$HOME/x:$PATH"`) is written as the *directory it resolved to*, not as the declaring text: the text is a template for the shell that read it, so replaying it could expand to a different folder — or to nothing — in the shell that sources `env.sh`. **Session entries that no longer exist** and **project-local session entries** (`node_modules/.bin`, `.venv/bin`, `__pypackages__`) are left out — they can never resolve for anyone, or only resolve while one project is open, and freezing them would break the user's permanent `PATH`. Each omission is reported back as an apply warning. A variable whose name is not a valid shell identifier (`[A-Za-z_][A-Za-z0-9_]*`) is also left out with its own warning: the name is interpolated into `export <name>=…`, so accepting `FOO; sh -c …` would run a second command in every new shell. Values are line-oriented for the same reason the scanner is: a value containing a literal line break is refused by the editor and skipped by Apply with a warning, because the next scan would read only its first line and the following Apply would then overwrite the rest. A PATH entry containing a line break is skipped with its own warning for the same reason.
   * **Variables from guarded profile scripts:** the scanner records assignments, not the `if` around them, so some declarations are conditional (locale, desktop fallbacks). A config-derived variable is only written when the recorded text can actually be replayed: if it references a variable this session does not define without a `:-`/`:+` fallback, or if it expands to a value other than the one that is active now, it is left to the profile script and the apply notice lists it. Values the user edited in the Variables view are always written as given, and a value already present in `env.sh` is trusted even when it differs from the running process — Apply cannot change the environment of the app that is already running, so comparing against it would delete the user's setting on the next Apply. The unset-reference guard is structural and applies even to edited values and profile presets: writing `${UNSET}.UTF-8` exports a fragment no matter who typed it. Without this guard, `/etc/profile.d/cedilla-portuguese.sh`'s `LC_CTYPE="${LC_IDENTIFICATION%.*}.UTF-8"` would export the invalid locale `.UTF-8` in every new shell on an English system.

---

## 4. Core Features Specification

### 4.1 PATH Health Check Engine (Doctor Engine)
Decomposes each `PATH` entry into an individual object, evaluates 7 diagnostic rules, and computes an overall health score.

| Code | Severity | Criteria | Quick Fix |
| :--- | :--- | :--- | :--- |
| `DEAD_PATH` | Error | Directory does not exist on disk | Remove immediately from list |
| `EMPTY_DIR` | Warning | Directory exists but contains 0 executable files. Reserved install directories a distribution ships empty (`/usr/local/bin`, `/usr/local/sbin`, `/usr/local/games`, `/usr/local/libexec`, `/usr/games`, `/usr/bin`, `/usr/sbin`, `/bin`, `/sbin`) are exempt | Suggest removal |
| `DUPLICATE` | Warning | Identical path registered 2+ times (compared after trailing slash `/`, `\` and case normalization) | Keep highest-priority entry and merge |
| `ALIAS_PATH` | Info | A different path resolves to the same physical directory as an earlier entry through a symlink (`/bin` -> `/usr/bin` on merged-`/usr` systems). Informational only: excluded from the health score and never merged by Clean All | None (distribution default is preserved) |
| `UNEXPANDED` | Tip | A **config file** spells the home folder out literally (`C:\Users\developer\...` / `/home/developer/...`) instead of using `%USERPROFILE%` / `$HOME`. Judged from the declaring file's own text (`PathEntry.source_text`), so an entry whose config already uses `$HOME` is never flagged | Shorten to `%USERPROFILE%\...` or `$HOME/...` |
| `PERMISSION_WARN` | Security | **World-writable** directory (mode `o+w`, without the sticky bit) that the shell searches — any local account can plant a command here. Checked from Unix mode bits; Windows ACLs are not inspected, so the rule does not fire there | Remove from PATH |
| `PATH_ORDER` | Tip | A user-writable directory searched *before* the core system directories. This is the documented layout for rustup/nvm/pyenv, so it is reported as hardening advice and carries **no** score penalty | Move priority below system paths |

> **`DUPLICATE` vs `ALIAS_PATH`:** `DUPLICATE` compares *path text* (after slash/case normalization) and therefore catches the actionable case where the same string was added twice. `ALIAS_PATH` resolves symlinks to detect that two *different* strings point at the same physical directory; this is almost always a distribution default (e.g. `/bin`), so it is reported as a non-blocking informational tip rather than a warning.

> **Scoped diagnostics:** `analyze_path_entries()` runs no rule at all on `Scope::Process` entries (see §3.2). They are neither findings nor score inputs, and the report lists them in a dedicated section.

> **Clean All and duplicates:** entries are de-duplicated within each class, and a session copy is dropped when a configured entry with the same text exists — in either order. Apply writes the configured entry (and may keep a live session copy), so keeping the session duplicate would bake the folder into the saved `PATH` twice, while keeping only the session copy would lose the setting. Clean All also refuses to remove the protected system folders, even when one is currently missing, so the Safe Guard cannot be defeated by a staged clean.

#### 4.1.1 Health score
```
penalty = min(dead * 8, 30) + min(duplicate * 5, 15) + min(empty * 3, 9)
        + min(unexpanded * 2, 8) + min(world_writable * 10, 25)
        + min(conflicts * 2, 12)
score   = 100 - min(penalty, 99)          # real 1..100 range
```
Each category is capped and the caps sum to 99, so no single noisy category can flatten the score to `0` and hide how the other categories are doing. `ALIAS_PATH`, `PATH_ORDER` and session entries cost nothing.

Session entries are skipped before any rule runs, and they are also skipped when binary occurrences are collected, so a session folder can never manufacture a shadowing conflict (and therefore can never cost points through `conflict * 2`).

#### 4.1.2 Counting executables
`scan_directory_executables()` counts one entry per **command name** — what a user sees when they list the folder and what the shell can resolve. `/snap/bin` therefore reports 11, even though its 11 symlinks all resolve to `/usr/bin/snap`. Physical-identity de-duplication happens *across* `PATH` entries (`(dev, ino)`), which is where it prevents bogus shadowing conflicts, plus a canonical-directory cache so an aliased directory is indexed only once.

### 4.2 Binary Shadowing Inspector
1. **How It Works:**
   * Traverses all valid directories in `PATH` in priority order and indexes executable files.
   * Considers `PATHEXT` (`.COM`, `.EXE`, `.BAT`, `.CMD`, etc.) on Windows and executable permission bits (`chmod +x`) on Linux.
2. **Conflict Grouping:**
   * Groups commands with the same name (e.g., `python`, `node`, `java`, `gcc`, `git`, `curl`) found in 2 or more directories into a **'Shadowed Group'**.
3. **Version Extraction (Async Worker):**
   * When major developer tools (`node`, `python`, `java`, `go`, `rustc`, etc.) are detected, runs `--version` in a background thread with a short timeout (300ms) to extract and display the version string in the UI.
   * *Example Display:*
     * **[Active]** `C:\Program Files\Python39\python.exe` `(v3.9.13)`
     * **[Shadowed]** `C:\Users\developer\AppData\Local\Programs\Python\Python312\python.exe` `(v3.12.4)` -> Provides **[Promote to Activate]** button.
4. **Windows hive order:** Windows composes the machine-wide System `PATH` before the per-user `PATH`, and Apply writes the two hives separately. A drag or **[Promote to Activate]** that would cross the User/System boundary is therefore refused with an explanation instead of staging an order Apply cannot persist; the fix is to remove the shadowing System entry (elevated) or add the folder to the System `PATH`. Adding a System entry inserts it into the System block, and an imported file or saved profile is normalized to System-before-User, so a newly built list starts in the order Windows actually searches.

### 4.3 Snapshot & Time-Machine (Snapshot & Rollback)
* **Automatic Backup:** Right before the user clicks [Apply], the current state is automatically recorded as a snapshot in the SQLite database.
* **Manual Snapshot:** `Take Snapshot Now` re-reads the live environment in the backend rather than storing the frontend's staged list. A staged but unapplied edit is not a state the machine ever had, so it must never become a rollback target.
* **Linux File Backup:** When modifying dotfiles such as `.bashrc` on Linux, a timestamped copy of the original file is saved under `~/.local/share/env-doctor/backups/`, readable only by its owner.
* **JSON / `.env` Export & Import:** The current configuration is exported as JSON (which the app can import again) or as a `.env` file for migrating a development environment to a new machine. An imported file is normalized before it is used: a missing scope becomes a user-level setting, a missing id is generated (duplicate ids get a suffix), duplicate variable rows collapse (the last declaration wins, except that a session row never replaces a declared one), and the findings are never taken over from the file — they are recomputed on this machine. Imported entries are re-anchored from their `raw_value` (`$HOME`, `%USERPROFILE%`, `~`) before existence and conflict checks, so a path exported on another machine is not shown as present just because the old absolute path exists on this one. A `Dotfile` scope imported on Windows becomes a `User` setting because Windows has no shell dotfiles. The `.env` writer doubles backslashes, escapes quotes and line breaks, and skips names that are not valid `.env` keys, so a Windows path such as `C:\temp` survives a dotenv parser instead of becoming a tab. An imported value containing shell command substitution is written literally, because an import is untrusted text: only the quote style of a scanned configuration file may opt a value into being a template. An import replaces only what it describes: an empty `path_entries` or `variables` array leaves that whole list untouched (a variables-only file cannot empty the staged PATH), a file with no `System` scope (a Linux export) leaves the existing HKLM environment untouched, and a file with no `User` rows keeps the current user rows. A scope the file does not describe is therefore left untouched, while a scope it does describe is replaced by the file's rows. When duplicate rows for one variable collapse, the last declaration wins but a session (`Process`) row never replaces a declared one, because Apply skips session variables. An Apply with both staged lists empty is refused while the machine has content, and so is restoring a snapshot that stores neither, so a failed initial scan or a corrupt snapshot row can never wipe the machine's environment.

### 4.4 Diagnostic Report Export
* **Formats:** `Markdown` (readable summary), `JSON` (structured machine-readable data) and `CSV` (one row per PATH entry). Rendered by `src/utils/reportExport.ts`.
* **Single source of wording:** The Markdown report calls `describeIssue()` from `src/utils/diagnosticMessages.ts` — the same catalog the Doctor view, PATH editor and right inspector render — so exported findings can never drift from the on-screen explanation.
* **Says where to fix it:** every finding and every CSV row carries a `Declared in` value (the file and line that declared the entry, or `not declared in any config file (session)`), so a reader never has to guess which file to edit. CSV columns are `position, scope, kind, declared_in, raw_value, resolved_value, exists, executable_count, issue_count, issues, issue_details`. A cell that starts with a spreadsheet formula character (`=`, `+`, `-`, `@`, tab) is prefixed with an apostrophe, so a hostile PATH entry cannot execute as a formula when the report is opened in a spreadsheet.
* **Session entries are separated, not hidden:** a `## Session PATH entries` section in Markdown, `session_path_entries` in the JSON summary and `kind=session` rows in CSV keep the effective `PATH` complete without presenting runtime injections as faults. The JSON summary also splits `world_writable_folders` from `user_folders_before_system_paths`.
* **Secret safety:** The export includes environment variable **counts only**, and the count is taken over variables that actually reach the environment (shell-script locals are excluded), so it matches what the Variables view lists. Values are deliberately omitted because reports are commonly attached to public issue trackers; the Time-Machine export remains the way to back up values.
* **Write path:** The frontend requests a destination with the `dialog` plugin's `save()` and posts the rendered text to the `save_export_file` Tauri command, which validates the path (absolute, not a directory), creates missing parent directories and returns the byte count. The backend deliberately exposes no general-purpose filesystem write. The dialog's `defaultPath` is the OS **Downloads** directory joined with the suggested file name (`@tauri-apps/api/path`), because a bare file name makes the dialog open in the app's working directory — `src-tauri/` under `tauri dev`.
* **Provider independence:** The report only contains data already held by the frontend store, so it works identically on Windows and Linux and needs no extra privileges.
* **Fidelity:** The report reflects exactly what the UI shows, including staged-but-unapplied edits, which are flagged with a "preview only" note.

---

## 5. Data Models & Core Rust Structures

Core data structures shared between the backend (Rust) and frontend (TypeScript).

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Scope {
    User,
    System,
    /// Contributed by the process/session rather than declared in a config file.
    /// No diagnostic rule runs on these entries and they are excluded from the score.
    Process,
    Dotfile {
        file_path: PathBuf,
        line_number: usize,
        /// `true` when the declaration was double-quoted, so `raw_value` holds
        /// the directory the shell expanded rather than the text in the file.
        /// Apply then writes that directory as data. Serde-defaulted and
        /// omitted when `false`, so older snapshots and imports stay valid.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        expanded: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DiagnosticIssue {
    DeadPath,
    Duplicate { first_seen_index: usize },
    AliasPath {
        canonical: String,
        first_seen_index: usize,
    },
    EmptyDirectory,
    UnexpandedVariable { suggested: String },
    /// World-writable folder searched by the shell: real exposure, scored.
    SecurityRisk { reason: String },
    /// User-writable folder searched before the system folders: hardening note,
    /// never scored (rustup/nvm/pyenv installs look exactly like this).
    OrderRisk { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathEntry {
    pub id: String,
    pub raw_value: String,
    pub resolved_value: PathBuf,
    pub scope: Scope,
    /// The fragment exactly as written in the declaring config file (e.g.
    /// `$HOME/.cargo/bin`), used so portability is judged from the file's text
    /// rather than from the expanded process value.
    pub source_text: Option<String>,
    pub exists: bool,
    pub executable_count: usize,
    pub issues: Vec<DiagnosticIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryConflict {
    pub binary_name: String,
    pub locations: Vec<BinaryInstance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryInstance {
    pub full_path: PathBuf,
    pub path_entry_index: usize,
    pub is_active: bool,
    pub version_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVariable {
    pub key: String,
    pub value: String,
    pub is_expandable: bool,
    pub scope: Scope,
    pub is_modified: bool,
}
```

---

## 6. UI / UX Layout Design (Wireframe)

Adopts a 3-Pane architecture (Left Navigation, Center Main View, Right Inspector) so users can assess system health at a glance and resolve issues with mouse actions alone.

```
+-----------------------------------------------------------------------------------+
| Env & PATH Doctor                               [Global Search (Ctrl+K)] [Apply(2)] |
+------------------+----------------------------------------+-----------------------+
| [Diagnostics]    | PATH Health Score: 78 / 100            | [Inspector]           |
|  * Health Check  | [Dead: 3] [Duplicate: 2] [Conflict: 4] |                       |
|  * PATH Editor   | [One-Click Clean All]                  | Selected:             |
|  * Shadowing     |----------------------------------------| Python 3.12 Path      |
|  * Variables     | [Filter: All | User | System | Session]|                       |
|                  |                                        | Source:               |
| [Safeguards]     | ≡ 1. [SYS] C:\Windows\System32    [OK] | HKCU\Environment      |
|  * Time Machine  | ≡ 2. [SYS] C:\Program Files\nodejs[OK] |                       |
|  * Profiles      | ≡ 3. [USR] C:\Old_SDK\bin        [ERR] | Issues Detected:      |
|                  |      └─ [Error] Directory missing [Del]| `python.exe` shadowed |
| [OS Context]     | ≡ 4. [USR] %LOCALAPPDATA%\Python [WRN] | by entry #1           |
|  Windows 11      |      └─ [Warn] python.exe shadowed [Up]|                       |
|  Length: 1,420   | ≡ 5. [USR] C:\Program Files\nodejs[WRN]| Executables (14):     |
|  [████░░] Safe   |      └─ [Warn] Duplicate of #2  [Merge]| - python.exe (v3.12.4)|
|                  |                                        | - pip.exe             |
|                  | [+ Add New Path (Browse Folder)]       |                       |
+------------------+----------------------------------------+-----------------------+
```

---

## 7. Project Directory Structure

Modularized frontend and Rust core following Tauri v2 conventions.

```text
env-path-doctor/
├── README.md
├── package.json
├── vite.config.ts
├── src/                                # Frontend (React + TypeScript)
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── common/                     # Theme-independent Select / ActionMenu, diagnostic issue card
│   │   ├── layout/                     # Sidebar, Header, RightInspector, Modals
│   │   ├── doctor/                     # Health check cards, Export report menu, One-Click Cleaner UI
│   │   ├── path-editor/                # Drag-and-drop PATH list (@dnd-kit)
│   │   ├── shadowing/                  # Binary Shadowing comparison view
│   │   ├── variables/                  # Environment variable editor & Secret Masking
│   │   ├── timemachine/                # Snapshot timeline and Diff viewer
│   │   └── profiles/                   # Environment profile switcher
│   ├── utils/
│   │   ├── diagnosticMessages.ts       # Shared diagnostic wording (UI + exported reports)
│   │   ├── reportExport.ts             # Markdown / JSON / CSV report rendering
│   │   └── saveFile.ts                 # Native save dialog + backend write
│   ├── store/
│   │   └── useEnvStore.ts              # Zustand state management (change staging)
│   └── types/
│       └── ipc.ts                      # TS types matching Rust structs 1:1
│
└── src-tauri/                          # Backend (Rust)
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── commands/                   # Tauri IPC command handlers called from frontend
        │   ├── mod.rs
        │   ├── env_cmds.rs
        │   ├── doctor_cmds.rs
        │   ├── export_cmds.rs          # Validated write of exported report text
        │   └── snapshot_cmds.rs
        ├── core/                       # Platform-independent business logic
        │   ├── mod.rs
        │   ├── doctor.rs               # Dead path, duplicate, and security analyzer
        │   ├── scanner.rs              # Executable indexing and Shadowing detector
        │   └── snapshot.rs             # SQLite snapshot storage and rollback engine
        └── platform/                   # OS-specific implementations
            ├── mod.rs                  # PlatformEnvManager Trait definition
            ├── windows.rs              # #[cfg(target_os = "windows")] Registry control
            └── linux.rs                # Dotfiles parser and shell tracer
```

---

## 8. Development Roadmap

### Phase 1: MVP - Read-Only Doctor (Weeks 1-2)
* Set up Tauri v2 + React boilerplate.
* Implement Windows Registry and Linux environment variable reader modules.
* Implement `PATH` decomposition with **Dead Path** and **Duplicate** detection UI.
* **Implement Binary Shadowing Scanner:** Find and display duplicate installations of `node`, `python`, `java`, `git`, etc.

### Phase 2: Safe Editor & Snapshot Time-Machine (Weeks 3-4)
* Implement SQLite-based automatic snapshot creation and rollback engine.
* Implement staging workflow to preview **Diffs visually before clicking [Apply]**.
* Integrate Windows Registry writing (`REG_EXPAND_SZ` preservation) and `WM_SETTINGCHANGE` broadcast.
* Implement Linux Managed Block (`env-doctor/env.sh`) injection and dotfile backup/update logic.

### Phase 3: Linux Advanced Features & Polish (Weeks 5-6)
* Integrate Linux shell tracer (`bash/zsh -xlc`) to map exact filenames and line numbers for each variable.
* Add deep links (`vscode://file/...:line`) to open configuration files at the exact line in external editors such as VS Code.
* Add one-click switching for development environment profiles (e.g., `Java 17 Project`, `Java 21 Project`).

---

## 9. Edge Cases & Security Considerations

1. **Critical System PATH Protection (Safe Guard):**
   * If a user attempts to delete critical OS paths such as `C:\Windows\System32` on Windows or `/usr/bin`, `/bin` on Linux, display a blocking modal and prevent deletion.
2. **Symlink & Identity Defense:**
   * Directory scanning is depth-1 (`read_dir`), never recursive, so a symlink loop can never be followed. Executables are classified by following the link once and keeping only regular files, and physical identity (`(dev, ino)`) is compared *across* `PATH` entries plus a canonical-directory cache, so an aliased directory (`/bin` -> `/usr/bin`) is indexed once and cannot shadow itself. Names that merely share a target file are still counted individually, because they are still distinct commands.
3. **Sensitive Information Masking (Secret Masking):**
   * When an environment variable key contains `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `PRIVATE`, `AUTH` or `API_KEY` (e.g., `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`), mask the value as `••••••••` by default in list views and in every diff preview (the pre-Apply diff and the Time-Machine diff), to prevent accidental leaks during screen sharing or screenshots. A missing value is rendered as nothing and a value set to the empty string as `(empty)`, so the two states stay distinguishable.