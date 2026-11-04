# Env & PATH Doctor

![Version](https://img.shields.io/badge/version-1.0.0-10b981)
![Tauri](https://img.shields.io/badge/Tauri-v2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![Rust](https://img.shields.io/badge/Rust-Edition_2021-f74c00)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20%7C%20Linux-blue)

**Env & PATH Doctor** is a cross-platform desktop application for diagnosing, visualizing, editing, and safely rolling back system environment variables and `PATH` configurations on Windows and Linux.

> **"Why is the `python`, `node`, or `java` binary I installed running an older version (Binary Shadowing)?"**  
> **"On Linux, which configuration file and which exact line added this `PATH` entry (Dotfile Tracing)?"**  
> **Env & PATH Doctor** identifies the root cause immediately and lets you fix it safely with drag-and-drop.

---

## Key Features

### 1. PATH Health Check Engine (Doctor Engine)
Decomposes each `PATH` entry into an inspectable object, evaluates 7 diagnostic rules, and calculates an overall **Health Score (1-100)**:
| Diagnostic Code | Severity | Criteria | Quick Fix |
| :--- | :---: | :--- | :--- |
| `DEAD_PATH` | Error | Directory does not exist on disk (ghost path) | Remove from list immediately |
| `EMPTY_DIR` | Warning | Directory exists on disk but contains 0 executables. Reserved install directories a distribution ships empty on purpose (`/usr/local/bin`, `/usr/local/sbin`, `/usr/local/games`, `/usr/local/libexec`, `/usr/games`, `/usr/bin`, `/usr/sbin`, `/bin`, `/sbin`) are exempt, because `make install` and local package builds are expected to fill them | Suggest removal |
| `DUPLICATE` | Warning | The identical path text is registered 2+ times after slash (`/`, `\`) and case normalization | Merge into higher-priority entry |
| `ALIAS_PATH` | Info | A *different* path that resolves to the same physical directory as an earlier entry through a symlink (e.g. `/bin` → `/usr/bin` on merged-`/usr` systems). Informational only: excluded from the health score and never merged by **Clean All**, so distribution defaults survive | None required |
| `UNEXPANDED` | Tip | A **config file** writes the home folder literally (`C:\Users\...` or `/home/...`) instead of using `%USERPROFILE%` / `$HOME`. Decided from the file's own text, so an entry added by nvm/rustup using `$HOME` is never flagged | Shorten to `%USERPROFILE%\...` or `$HOME/...` |
| `PERMISSION_WARN` | Security | **World-writable** directory (mode `o+w` without the sticky bit) that the shell searches. Any account could drop a program here that runs instead of the real command. Checked from Unix mode bits; Windows ACLs are not inspected, so this rule does not fire there | Remove from PATH |
| `PATH_ORDER` | Tip | A *user-writable* directory is searched before the core system directories. This is exactly how rustup, nvm, pyenv and asdf are meant to be installed, so it is a hardening note and costs **no** health score | Move below the system folders |

- **One-Click Clean All:** Removes dead paths, merges duplicates, and shortens unexpanded home paths in a single staged action. Symlink aliases (`ALIAS_PATH`) are deliberately left untouched.

#### Session entries are not your configuration
A `PATH` is not only made of files: whatever process starts the app can prepend directories of its own. Running the app with `npm run` adds `node_modules/.bin` for the project and every ancestor folder (most of which do not exist) plus `node-gyp-bin`, and tool managers quietly add their own bin folders.

Entries that **no readable config file declares** are classified as **session entries** and handled separately:

- they are never reported as dead paths, never get a security warning and never lower the health score;
- a session folder that shadows a config-declared command is **not** reported as a binary conflict either, because a conflict is a finding and the user cannot fix a folder they never configured;
- they are listed in their own section in the Doctor view, in the `.md`/`.csv` report and in the `session_path_entries` JSON field, so the effective `PATH` is still fully visible;
- on **Apply**, a session entry is written back only when it is a real *tool* folder. Entries that no longer exist are dropped (they can never resolve for anyone), and so are **project-local** folders such as `node_modules/.bin` or `.venv/bin` — those exist only while one project is open and would become a broken path in your permanent `PATH`. A live tool folder such as `~/.nvm/.../bin` is kept, because dropping it would remove `node` from every new shell.

The health score also caps each category (dead paths 30, duplicates 15, empty folders 9, hard-coded home paths 8, world-writable folders 25, shadowing conflicts 12; 99 total) so one noisy category can no longer drive the score to a flat `0` and hide how bad the other categories are.

### 2. Binary Shadowing Inspector
- Indexes all valid directories in `PATH` in priority order (respecting `PATHEXT` on Windows and executable permission bits `0o111` on Linux) to detect commands (`python`, `node`, `java`, `git`, `gcc`, `cargo`, etc.) installed across multiple directories.
- Runs a background multi-threaded worker with a strict 300ms timeout (`CREATE_NO_WINDOW`) to probe `--version` / `-version` strings.
- Promotes any shadowed binary to active priority in one click via **[Promote to Activate]**.
- **Windows hive order:** the machine-wide System `PATH` is always searched before the per-user `PATH`, and Apply saves the two hives separately. A User entry therefore cannot be promoted above a System one by dragging; the app reports the limitation instead of staging an order Apply cannot honor. To change which copy runs, remove the shadowing System entry (Apply asks for administrator rights) or add the folder to the System `PATH`; a newly added System entry is inserted into the System block, and imports/profiles are normalized to the same order.

### 3. Windows & Linux Native Adapters
- **Windows Adapter (`src-tauri/src/platform/windows.rs`):**
  - Separately loads User (`HKCU\Environment`), System (`HKLM\...\Environment`), and runtime Process variables.
  - **Strict `REG_SZ` vs `REG_EXPAND_SZ` Preservation:** Ensures paths containing `%SystemRoot%` or `%USERPROFILE%` are always stored as `REG_EXPAND_SZ` so Windows never fails to expand them.
  - **Immediate Hot Reload:** Broadcasts `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, ..., "Environment")` after registry updates so Explorer and new terminals pick up changes without a reboot.
  - **UAC Privilege Separation:** Runs under standard user permissions and only invokes an elevated PowerShell UAC helper when System (`HKLM`) variables are modified.
- **Linux Adapter (`src-tauri/src/platform/linux.rs`):**
  - **Step 1 - Read & Trace:** Statically parses every file that can contribute a `PATH` fragment — `/etc/environment`, `/etc/profile`, `/etc/profile.d/*.sh`, `/etc/environment.d/*.conf`, `/usr/lib/environment.d/*.conf` (systemd user session, where snapd appends `/snap/bin`), `~/.pam_environment` (pam_env's `KEY [DEFAULT=]value` syntax), `~/.profile`, `~/.bash_profile`, `~/.bashrc`, `~/.cargo/env`, `~/.zshenv`, `~/.zshrc`, `~/.config/fish/config.fish`, `~/.config/environment.d/*.conf` — and additionally traces `bash/zsh -xlc "env"` to attribute a fragment to a script that adds it dynamically (line numbers are exact for the statically parsed files). The app's own `zz-env-doctor.conf` is not treated as a source, and `env.sh` is only a fallback origin, so the report never cites the app as the author of the user's configuration.
  - **Per-occurrence attribution:** every declared fragment is remembered together with the file and line that declared it, in scan order. When the same fragment appears twice (e.g. `/etc/environment` sets `/snap/bin` and `990-snapd.conf` appends it again), each copy reports *its own* declaring file, and the report always states `Declared in: <file> (line n)`.
  - **Double-quoted declarations are expanded:** `PATH="$HOME/.local/bin:$PATH"` is stored by the parser as the text the file contains, but the live `PATH` only ever holds the expanded folder. The text is therefore expanded the way a POSIX shell expands it inside double quotes (`$VAR`, `${VAR}`, a leading `~`), which is what lets such a folder keep its declaring file and line. Single-quoted and unquoted values are literal and are not expanded. Only this simple form is modelled: `${VAR:-default}`, `${VAR%%.*}` and `$(…)` are left verbatim rather than guessed at. The resolved directory is what Apply writes back for these entries: the declaring text is a template for the shell that read it, so replaying it could expand to something else in the shell that sources `env.sh`.
  - **Session classification:** an entry no config file declares is reported as a session entry (badge `PROC`) instead of being guessed as User/System from its location on disk.
  - **Only real environment variables are listed:** a `KEY=value` line counts as an environment variable only when the file actually exports it — `export KEY=...`, fish's `set -gx KEY ...`, or a later bare `export KEY` (the two-step style used by `/etc/profile.d/xdg_dirs_desktop_session.sh`). Shell scripts are full of locals (`key`, `val`, `prefix`, `desktops`, `bad_kv`) that never leave the script; counting them inflated the reported total and filled the Variables view with names nobody can act on. `/etc/environment` and `environment.d/*.conf` keep *every* assignment, because in those files the assignment **is** the declaration; `~/.pam_environment` is read with pam_env's own syntax.
  - **VS Code Deep Links:** Opens the exact file and line number in VS Code via `vscode://file/...:line`.
  - **Step 2 - Safe Managed Block Writing:** Creates timestamped, owner-only backups in `~/.local/share/env-doctor/backups/` and manages overrides cleanly inside `~/.config/env-doctor/env.sh`. A variable read from your own dotfile cannot be deleted from the Variables view (Apply only writes `env.sh`, so the original `export` would keep running); edit that file instead, or override the value here. Dead and project-local session entries are left out of the written `PATH` so runtime injections are never frozen into your configuration. Values are quoted for the shell: a literal value (one the user typed) is single-quoted so `$` and backslashes stay literal — and the quote style is remembered by the next scan, so `pa$$` is never re-read as the shell PID — while a value read from a config file keeps its `${VAR:-default}` / `$(...)` / `~` expansion. The quoting in the file a value came from decides this: `export TOKEN='pa$$word'` in your `.bashrc` stays a literal, and it is never written back as `"pa$$word"`, which would expand `$$` to the process id in every new shell. Quotes and escapes decide, not the characters in the value: `export A="\$HOME"` and `export A="~/bin"` are literals, while `export A=$HOME` and `export A=~/bin` stay templates. A value that ends with a backslash can therefore never terminate the quote and break every new shell. Values are single-line on Linux: `env.sh` is read back line by line, so the editor refuses a value containing a line break and Apply skips one with a warning instead of truncating it on the next scan. Conditional profile exports are not replayed blindly: a variable whose declaration needs a value this session does not define, or that no longer expands to the value that is active now, is left to the profile and listed in the Apply notice. Variables already stored in `env.sh` and values edited in the Variables view (or loaded from a profile) are always kept, except that a value referencing an unset variable with no fallback is still skipped, and a variable whose name is not a valid shell identifier is skipped with its own warning so it cannot inject a command.

### 4. Time-Machine Snapshots (SQLite + Git Diff Rollback) & Profiles
- **Automatic Pre-Apply Snapshots:** Automatically records the current environment state in a local SQLite database (`snapshots.db`, mode `0600`) right before applying any changes. Session-only variables are not stored: they are never written back by Apply, so copying them would only persist unrelated tokens and API keys.
- **Manual Snapshots:** `Take Snapshot Now` reads the live environment through the backend, exactly like the automatic pre-Apply backup. Staged edits that have not been applied are not copied, so restoring a snapshot never installs a configuration that never existed on the machine.
- **Staging & Visual Diff Workflow:** All edits (drag-and-drop reordering, deletions, variable updates) are staged first so you can review a **Structured Diff or Git Unified Diff** (powered by the `similar` crate) before applying.
- **1-Second Rollback & Export/Import:** Restore any historical snapshot in one click, or export the configuration in `JSON` (which can be imported again) and `.env` formats. Both exports contain only restorable (non-session) variables for the same reason as snapshots. The `.env` writer escapes backslashes, quotes and line breaks (so `C:\temp` is not read as a tab by a dotenv parser) and skips names that are not valid `.env` keys. An imported value that contains shell command substitution (`$(…)` or backticks) is staged as a literal, and the written `PATH` escapes every expansion except the portable `$HOME` form, so an imported file cannot make every new shell run a command. A hand-edited file may omit one half of the configuration: an empty `path_entries`/`variables` array leaves that list untouched, and a file without `User`/`System` rows keeps the current rows of those scopes.
- **Environment Profiles:** Save and switch between project-specific variable sets (e.g., `Java 17 LTS`, `Java 21 LTS`, `Python UTF-8`) with one click.

### 5. Safeguards & Security
- **Critical System PATH Protection (Safe Guard):** Blocks accidental deletion of essential OS directories (`C:\Windows\System32`, `C:\Windows`, `/usr/bin`, `/bin`) with a protective modal.
- **Physical-identity de-duplication:** Each `PATH` directory is canonicalized and scanned once, and the files behind its names are compared by `(dev, ino)` *across* entries. This is what stops merged-`/usr` layouts (`/bin`, `/usr/bin`, `/usr/sbin`, `/sbin`) from reporting thousands of phantom shadowing conflicts, while still counting every command *name* a directory provides (`/snap/bin` has 11 names even though they all resolve to `/usr/bin/snap`).
- **Secret Masking:** Automatically masks values of variables whose names contain `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `PRIVATE`, or `AUTH` as `••••••••••••••••` in list views and in every diff preview (the pre-Apply diff and the Time-Machine diff).

### 6. Diagnostic Report Export
- **`Export report` menu (Doctor view):** Saves the current scan result to a file you choose, in one of three formats — **Markdown** (readable summary for a chat or issue), **JSON** (structured data for scripts), or **CSV** (one row per PATH entry, for spreadsheets).
- **Same wording as the UI:** The report is rendered from the same message catalog the Doctor view uses, so an exported finding explains the problem exactly like the screen does.
- **Says where to fix it:** Every finding and every CSV row carries the file and line the entry was declared in (`Declared in`), and session entries are reported as such instead of being guessed from their location.
- **Session entries are listed apart:** A `## Session PATH entries` section (and a `session_path_entries` summary field / `kind=session` CSV rows) keeps the effective `PATH` complete without presenting runtime injections as faults.
- **Secret-safe by design:** Environment variable **values are never written to a report** — a shared report would otherwise leak API keys. Only the variable count is included (counted over variables that actually reach the environment, so shell-script locals no longer inflate it); use the Time-Machine export to back up values.
- **Native save dialog:** Uses the OS save dialog instead of a browser download, which does not work inside the Tauri webview. It opens in your **Downloads** folder rather than the app's working directory, so an exported report does not land in `src-tauri/` when you run the app in development.
- **Reproduces the visible state:** If changes are staged but not applied, the report carries a "preview only" note with the number of pending changes.

---

## Directory Structure

```text
envital/
├── docs/
│   └── ARCHITECTURE_SPEC.md            # System architecture & detailed design specification
├── scripts/
│   ├── build.ps1                       # Windows unified build/test/packaging script (PowerShell)
│   └── build.sh                        # Linux/macOS unified build/test/packaging script (Bash)
├── src/                                # Frontend (React 19 + TypeScript + Tailwind CSS v4)
│   ├── main.tsx
│   ├── App.tsx                         # 3-Pane main layout & external change event listener
│   ├── types/
│   │   └── ipc.ts                      # TypeScript types matching Rust structs 1:1 & security helpers
│   ├── services/
│   │   └── tauriClient.ts              # Tauri IPC invoke wrapper & browser preview fallback
│   ├── utils/
│   │   ├── diagnosticMessages.ts       # Single source of diagnostic wording shown in the UI & exports
│   │   ├── reportExport.ts             # Markdown / JSON / CSV diagnostic report rendering
│   │   └── saveFile.ts                 # Native save-dialog + backend write (browser download fallback)
│   ├── store/
│   │   └── useEnvStore.ts              # Zustand global state, change staging & Undo/Redo stacks
│   └── components/
│       ├── common/                     # Shared UI: theme-independent Select, ActionMenu, diagnostic card
│       ├── layout/                     # Header (Ctrl+K search), Sidebar (OS Context), RightInspector, Modals
│       ├── doctor/                     # Health score card, Export report menu & One-Click Cleaner (DoctorView)
│       ├── path-editor/                # @dnd-kit drag-and-drop PATH editor (PathEditorView)
│       ├── shadowing/                  # Binary Shadowing comparison view (ShadowingView)
│       ├── variables/                  # Environment variable editor & Secret Masking (VariablesView)
│       ├── timemachine/                # SQLite snapshot timeline & Git Diff viewer (TimeMachineView)
│       └── profiles/                   # Environment profile switcher (ProfilesView)
└── src-tauri/                          # Backend (Rust + Tauri v2)
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── lib.rs                      # Tauri plugins, notify file watcher & IPC handler registration
        ├── commands/                   # Tauri IPC command handlers
        │   ├── doctor_cmds.rs
        │   ├── env_cmds.rs
        │   ├── export_cmds.rs          # Validated write of exported report text
        │   └── snapshot_cmds.rs
        ├── core/                       # Platform-independent business logic
        │   ├── mod.rs                  # Shared data models
        │   ├── doctor.rs               # 7 diagnostic rules, health score, cleaner & Safe Guard
        │   ├── scanner.rs              # Executable indexing, Binary Shadowing & 300ms version probing
        │   └── snapshot.rs             # SQLite snapshot/profile manager & similar Diff engine
        └── platform/                   # OS-specific implementations
            ├── mod.rs                  # PlatformEnvManager Trait definition
            ├── windows.rs              # Win32 Registry (HKCU/HKLM), REG_EXPAND_SZ, WM_SETTINGCHANGE, UAC helper
            └── linux.rs                # Dotfiles static parser, bash/zsh tracer, Managed Block & backups
```

---

## Prerequisites

- **Node.js:** v20 or higher (v22+ recommended) and `npm`
- **Rust:** Latest stable toolchain via `rustup` (`rustc`, `cargo`)
- **Platform-specific dependencies:**
  - **Windows 10/11:** Microsoft Visual Studio C++ Build Tools & WebView2 Runtime (pre-installed on Windows 11)
  - **Linux (Ubuntu/Debian):**
    ```bash
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf rpm
    ```

---

## Build & Run Guide

### 1. Using Unified Build Scripts (Recommended)

Platform build scripts ([`scripts/build.ps1`](./scripts/build.ps1) and [`scripts/build.sh`](./scripts/build.sh)) are located in the `scripts/` directory.

#### Windows (PowerShell)
```powershell
# Full build (Frontend build + Rust unit tests + Tauri installer bundles .msi/.exe)
.\scripts\build.ps1

# Quick verification (Frontend build + Rust unit tests + cargo check)
.\scripts\build.ps1 -Target check

# Build frontend only
.\scripts\build.ps1 -Target frontend

# Run Rust unit tests only
.\scripts\build.ps1 -Target test

# Build desktop bundle with debug symbols
.\scripts\build.ps1 -Target bundle -DebugBuild

# Clean build artifacts (removes dist/ and src-tauri/target)
.\scripts\build.ps1 -Target clean
```

#### Linux / macOS (Bash)
```bash
chmod +x ./scripts/build.sh

# Full build (generates .deb / .AppImage / .rpm)
./scripts/build.sh all

# Quick verification (Frontend build + Rust unit tests & check)
./scripts/build.sh check

# Clean build artifacts
./scripts/build.sh clean
```

---

### 2. Using npm Scripts

All development, testing, and packaging workflows are also available via [`package.json`](./package.json) scripts:

| Command | Description |
| :--- | :--- |
| `npm install` | Install frontend dependencies |
| `npm run dev` | Start Vite dev server (`http://localhost:1420`, includes browser preview fallback) |
| `npm run dev:tauri` | **Launch Tauri native desktop app in development mode** (with Hot Reload) |
| `npm run check` | Run frontend production build + Rust unit tests + Rust binary check |
| `npm run build` | Run TypeScript type check (`tsc`) and build production frontend bundle (`dist/`) |
| `npm run test:rust` | Run Rust core unit tests (`doctor`, `snapshot`, `linux` dotfile parser) |
| `npm run build:tauri` | Build production native installer bundles (`.msi`, `.exe`, `.deb`, `.AppImage`, `.rpm`) |
| `npm run script:win:check` | Run the PowerShell build script in `check` mode |

---

---

## Troubleshooting

### Blank / white window that never repaints (Linux)

On some virtual machines (VMware `vmwgfx`, SPICE `qxl`, VirtualBox, QEMU) and on
hosts without a usable DRM device, WebKitGTK's DMA-BUF renderer fails silently:
the window paints once and then stays blank when you move or resize it. The app
detects these environments at startup and automatically falls back to WebKit's
software renderer, so no configuration is required.

To force a specific behaviour, set the variable yourself — it always wins over
auto-detection:

```bash
# Force the software renderer (fixes a blank window)
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run dev:tauri

# Force the accelerated renderer back on (e.g. after a driver update)
WEBKIT_DISABLE_DMABUF_RENDERER=0 npm run dev:tauri
```

### Unreadable dropdown list on a light desktop theme (Linux)

A native `<select>` popup is not drawn by the web page — on Linux GTK draws it. With a
light desktop theme (for example Ubuntu's Yaru, which reports
`org.gnome.desktop.interface color-scheme 'default'`) the popup background is white
while the page's light text colour is applied to the menu items, so the options become
white-on-white and effectively invisible.

The app therefore never relies on the platform popup:

- `src/components/common/Select.tsx` renders the option list in the app's own dark
  palette, so it looks the same on every desktop theme.
- `color-scheme: dark` (CSS + `<meta>`) makes the browser draw the remaining native
  widgets — checkboxes, scrollbars, file pickers — with dark defaults.

---

## Keyboard Shortcuts

- `Ctrl + K` (or `Cmd + K`): Focus global search bar (instantly filters paths, executables, and variables)
- `Ctrl + Z`: Undo staged change
- `Ctrl + Y` (or `Ctrl + Shift + Z`): Redo staged change

---

## Architecture Specification
- See [`docs/ARCHITECTURE_SPEC.md`](./docs/ARCHITECTURE_SPEC.md) for the complete system architecture and design specification.
