use crate::core::doctor::{
    expand_path_variables, is_app_generated_config, is_core_system_bin_dir,
};
use crate::core::{EnvVariable, OsContext, PathEntry, Scope};
use crate::platform::PlatformEnvManager;
use chrono::Local;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

const MANAGED_BLOCK_START: &str = "# >>> env-doctor initialize >>>";
const MANAGED_BLOCK_END: &str = "# <<< env-doctor initialize <<<";

/// Whether `name` is a syntactically valid shell/environment variable name.
fn is_valid_variable_name(name: &str) -> bool {
    !name.is_empty()
        && !name.chars().next().unwrap().is_ascii_digit()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub struct LinuxEnvManager;

impl LinuxEnvManager {
    pub fn new() -> Self {
        Self
    }

    /// Read a `KEY=value` field from `/etc/os-release`, e.g. `PRETTY_NAME`.
    fn os_release_field(key: &str) -> Option<String> {
        let content = fs::read_to_string("/etc/os-release").ok()?;
        for line in content.lines() {
            let Some(rest) = line.strip_prefix(key) else {
                continue;
            };
            let Some(value) = rest.strip_prefix('=') else {
                continue;
            };
            return Some(value.trim().trim_matches('"').to_string());
        }
        None
    }

    /// Distribution name for the report header, e.g. `Ubuntu 24.04.3 LTS`.
    fn distro_name() -> String {
        Self::os_release_field("PRETTY_NAME")
            .or_else(|| Self::os_release_field("NAME"))
            .unwrap_or_else(|| format!("{} (Linux)", std::env::consts::OS))
    }

    /// Distribution release for the report header, e.g. `24.04`.
    fn distro_version() -> String {
        Self::os_release_field("VERSION_ID")
            .unwrap_or_else(|| std::env::consts::OS.to_string())
    }

    /// Whether a PATH entry belongs in the saved configuration.
    ///
    /// Entries declared in a config file always do. Session entries that resolve
    /// to a real *tool* folder (nvm, rustup, mise, …) are kept, because they are
    /// how those tools put their binaries on the PATH and dropping them would
    /// break the user's toolchain. Session entries that cannot resolve for anyone
    /// are left out: a deleted folder, or a project-local folder such as
    /// `node_modules/.bin` that only exists while one project is being worked on.
    /// Writing those back would freeze a transient path into the permanent PATH.
    pub fn should_persist_path_entry(entry: &PathEntry) -> bool {
        if entry.scope != Scope::Process {
            return true;
        }
        // Re-stat instead of trusting `exists`: a snapshot stores the flag from
        // the moment it was taken, and restoring it must not bake a folder that
        // has since been deleted into the saved PATH (or drop one that now
        // exists).
        let live = entry.resolved_value.exists() && entry.resolved_value.is_dir();
        live && !Self::is_build_injected_dir(&entry.resolved_value)
    }

    /// Escape a value for systemd's `environment.d` files.
    ///
    /// The parser reads the rest of the line as the value, strips one pair of
    /// surrounding quotes and interprets backslash escapes, so the value is
    /// written quoted and escaped. A folder whose name contains a quote or a
    /// backslash would otherwise reach the GUI session with a different path
    /// than the user reviewed.
    pub fn systemd_env_value(value: &str) -> String {
        format!(
            "\"{}\"",
            value.replace('\\', "\\\\").replace('"', "\\\"")
        )
    }

    /// Folders a build tool injects into `PATH` for the duration of one command.
    ///
    /// `npm run` prepends every ancestor `node_modules/.bin` plus npm's own
    /// `node-gyp-bin`; Python tooling prepends a virtualenv's `bin`. All of them
    /// are temporary: freezing one into the saved configuration leaves a dead
    /// folder as soon as the project moves, the toolchain is upgraded or the venv
    /// is removed. Entries the user declared in a config file never reach this
    /// check, so an explicit choice is always kept.
    ///
    /// The `node_modules` component match deliberately also catches npm's
    /// `lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin`:
    /// npm re-adds that folder for each lifecycle script, so it must not be
    /// written to `env.sh` either.
    pub fn is_build_injected_dir(path: &Path) -> bool {
        const PROJECT_MARKERS: &[&str] = &["node_modules", ".venv", "venv", "__pypackages__"];
        path.components().any(|component| {
            let name = component.as_os_str().to_string_lossy();
            PROJECT_MARKERS.iter().any(|marker| name == *marker)
        })
    }

    /// Quote one value for the managed `env.sh`.
    ///
    /// Values that came from a config file are written back verbatim so that
    /// shell syntax keeps its original meaning: `${XDG_DATA_DIRS:-...}`,
    /// `$(cmd)` and a leading `~` are still expanded by the shell that sources
    /// the file. Everything else is a literal the user typed, so it is
    /// single-quoted — otherwise a value such as `$5` would silently expand to
    /// the empty string. In both cases backslashes are escaped so a value that
    /// ends with `\` can never terminate the quote and break every new shell.
    pub fn shell_quote(value: &str, expandable: bool) -> String {
        if expandable {
            format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
        } else {
            format!("'{}'", value.replace('\'', "'\\''"))
        }
    }

    /// Quote the joined `PATH` for the managed `env.sh`.
    ///
    /// The PATH is written inside double quotes so the `$HOME/...` form that
    /// Clean All produces keeps expanding. Unlike a config-derived variable
    /// value, a PATH component is never meant to run code: an imported or edited
    /// entry could contain `$(...)` or a backtick, and a folder name can contain
    /// a literal `$`. Those are escaped, so sourcing the file can never execute
    /// a command hidden in the PATH.
    pub fn shell_quote_path(value: &str) -> String {
        let chars: Vec<char> = value.chars().collect();
        let mut out = String::with_capacity(value.len() + 2);
        out.push('"');
        for index in 0..chars.len() {
            match chars[index] {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '`' => out.push_str("\\`"),
                '$' if !Self::is_home_expansion(&chars, index) => out.push_str("\\$"),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    /// Whether `chars[index..]` starts the `$HOME` / `${HOME}` form that
    /// `shell_quote_path` deliberately leaves expandable.
    fn is_home_expansion(chars: &[char], index: usize) -> bool {
        let tail: String = chars[index..].iter().take(8).collect();
        if tail.starts_with("${HOME}") {
            return true;
        }
        match tail.strip_prefix("$HOME") {
            // `$HOMEDIR` is a different variable, not the home folder.
            Some(rest) => !rest
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'),
            None => false,
        }
    }

    /// Text that will be quoted before it reaches the shell.
    ///
    /// A leading `~` is only expanded by the shell when it is unquoted and at
    /// the start of a word, but the managed `env.sh` writes every value inside
    /// double quotes, where `~` stays literal. Rewriting it to the equivalent
    /// `$HOME` form keeps the value that the user (or the original dotfile)
    /// meant, because `$HOME` *is* expanded inside double quotes.
    pub fn as_shell_text(value: &str) -> String {
        if value == "~" {
            "$HOME".to_string()
        } else if let Some(rest) = value.strip_prefix("~/") {
            format!("$HOME/{}", rest)
        } else {
            value.to_string()
        }
    }

    /// `export KEY=value` line for the managed `env.sh`.
    pub fn env_sh_variable_line(var: &EnvVariable) -> String {
        let value = if var.is_expandable {
            Self::as_shell_text(&var.value)
        } else {
            var.value.clone()
        };
        format!(
            "export {}={}",
            var.key,
            Self::shell_quote(&value, var.is_expandable)
        )
    }

    /// Leading `[A-Za-z_][A-Za-z0-9_]*` of a `${...}` body.
    fn leading_variable_name(inner: &str) -> &str {
        let mut end = 0;
        for (idx, c) in inner.char_indices() {
            let valid = if idx == 0 {
                c.is_ascii_alphabetic() || c == '_'
            } else {
                c.is_ascii_alphanumeric() || c == '_'
            };
            if !valid {
                break;
            }
            end = idx + c.len_utf8();
        }
        &inner[..end]
    }

    /// Name of the first variable that a shell value needs but the current
    /// environment does not define, where the reference has no fallback word.
    ///
    /// `$HOME/.nvm` needs `HOME`; `${XDG_DATA_DIRS:-/usr/share}` does not,
    /// because `:-` covers an unset variable. `${LC_IDENTIFICATION%.*}` does
    /// need it: with the variable unset the expression yields an empty string,
    /// so a literal tail such as `.UTF-8` turns into a broken value.
    fn first_unset_variable(value: &str) -> Option<String> {
        let chars: Vec<char> = value.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '\\' {
                i += 2;
                continue;
            }
            if chars[i] != '$' || i + 1 >= chars.len() {
                i += 1;
                continue;
            }
            match chars[i + 1] {
                // `$$`, `$?`, `$#`, `$@`, `$1`, `$(...)` and friends are
                // supplied by the shell itself or evaluated at source time.
                '$' | '!' | '?' | '#' | '@' | '*' | '-' | '0'..='9' | '(' => i += 2,
                '{' => {
                    let Some(close_offset) = chars[i + 2..].iter().position(|&c| c == '}') else {
                        break;
                    };
                    let start = i + 2;
                    let end = start + close_offset;
                    let inner: String = chars[start..end].iter().collect();
                    let name = Self::leading_variable_name(&inner);
                    if !name.is_empty() {
                        let rest = &inner[name.len()..];
                        // `:-`, `-`, `:=`, `=`, `:?`, `?`, `:+` and `+` all
                        // define the expansion when the variable is unset or
                        // empty; suffix operations (`%`, `#`, `/`, ...) do not.
                        let has_fallback = ["-", ":-", "=", ":=", "?", ":?", "+", ":+"]
                            .iter()
                            .any(|op| rest.starts_with(op));
                        if !has_fallback && std::env::var_os(name).is_none() {
                            return Some(name.to_string());
                        }
                    }
                    i = end + 1;
                }
                c if c.is_ascii_alphabetic() || c == '_' => {
                    let mut end = i + 1;
                    while end < chars.len()
                        && (chars[end].is_ascii_alphanumeric() || chars[end] == '_')
                    {
                        end += 1;
                    }
                    let name: String = chars[i + 1..end].iter().collect();
                    if std::env::var_os(&name).is_none() {
                        return Some(name);
                    }
                    i = end;
                }
                _ => i += 1,
            }
        }
        None
    }

    /// Render one variable for the managed `env.sh`, or drop it when the
    /// recorded declaration cannot be replayed safely.
    ///
    /// The scanner records assignments, not the `if` around them. System profile
    /// scripts guard locale and desktop exports with conditions, so replaying the
    /// text unconditionally can invent a value the machine never had — for
    /// example `LC_CTYPE="${LC_IDENTIFICATION%.*}.UTF-8"` is written from
    /// `/etc/profile.d/cedilla-portuguese.sh` even on an English system, and
    /// every new shell then prints `setlocale: LC_CTYPE: cannot change locale
    /// (.UTF-8)`. Two guards:
    ///
    /// * A reference to a variable this session does not define (and that has no
    ///   `:-`/`:+` fallback) is skipped: the shell would export a fragment.
    /// * A declaration that expands to something other than the value that is
    ///   active right now is a conditional or fallback branch; replaying it after
    ///   the user's profile has run would overwrite the correct value.
    ///
    /// The profile keeps applying these variables, so nothing is lost. Values the
    /// user edited by hand (`is_modified`, including a profile's chosen values)
    /// are written as given, except that the structural guard above still applies:
    /// an unset reference would be exported as a fragment no matter who typed it.
    fn safe_variable_line(var: &EnvVariable) -> Option<String> {
        if var.scope == Scope::Process || var.key == "PATH" || !is_valid_variable_name(&var.key) {
            return None;
        }
        // `env.sh` is read back line by line. A value with a literal line break
        // would be written correctly (the shell handles multi-line quotes) but
        // the next scan would see only its first line, and the Apply after that
        // would overwrite the rest. Refuse instead of silently losing data.
        if var.value.contains('\n') || var.value.contains('\r') {
            return None;
        }
        // A literal value is single-quoted, so `$` inside it is never expanded
        // and there is nothing to guard against.
        if !var.is_expandable {
            return Some(Self::env_sh_variable_line(var));
        }
        // This is a structural check, not a staleness check: even a value the
        // user edited (or a profile value) would be written as a fragment when
        // the variable it references is unset, so it applies to every value.
        if Self::first_unset_variable(&var.value).is_some() {
            return None;
        }
        if var.is_modified {
            return Some(Self::env_sh_variable_line(var));
        }
        // A value already stored in the app's own env.sh was vetted when it was
        // written (or edited by the user). The running process still holds the
        // environment from before Apply, so comparing the saved value against it
        // would drop the user's edit on the very next Apply.
        let already_applied = matches!(
            &var.scope,
            Scope::Dotfile { file_path, .. } if is_app_generated_config(file_path)
        );
        if already_applied {
            return Some(Self::env_sh_variable_line(var));
        }
        let expanded = expand_path_variables(&var.value, &HashMap::new())
            .to_string_lossy()
            .into_owned();
        // An unresolved `$` in the output means the expander could not model the
        // expression; do not compare it against the live value.
        if !expanded.contains('$') {
            if let Ok(live) = std::env::var(&var.key) {
                if expanded != live {
                    return None;
                }
            }
        }
        Some(Self::env_sh_variable_line(var))
    }

    /// Record every spelling of each PATH fragment in `value`, in declaration
    /// order. Keeping the whole list is what lets the report attribute the second
    /// copy of `/snap/bin` to `990-snapd.conf` instead of the first one's file.
    fn record_path_origins(
        target: &mut HashMap<String, Vec<(Scope, String)>>,
        value: &str,
        scope: &Scope,
        env_lookup: &HashMap<String, String>,
    ) {
        for fragment in value.split(':') {
            let clean = fragment
                .trim()
                .trim_start_matches("$PATH")
                .trim_end_matches("$PATH")
                .trim_matches(':');
            if clean.is_empty() {
                continue;
            }
            let expanded = expand_path_variables(clean, env_lookup);
            for key in [expanded.to_string_lossy().to_string(), clean.to_string()] {
                let origins = target.entry(key).or_default();
                if !origins.iter().any(|(seen, _)| seen == scope) {
                    origins.push((scope.clone(), clean.to_string()));
                }
            }
        }
    }

    /// Whether the value of a `KEY=...` line was written with single quotes.
    ///
    /// `env.sh` uses single quotes for literal values and double quotes for
    /// values the shell should still expand, and a user's own config states the
    /// same intent. The quotes themselves are stripped when the file is read, so
    /// this is the only signal that keeps a literal `$5`/`pa$$` from being
    /// re-interpreted (and corrupted) on the next Apply.
    ///
    /// Production code reads the whole quoting/escaping context in
    /// `value_uses_expansion`; this helper is kept for the tests that document
    /// the single-quote rule.
    #[cfg(test)]
    fn value_is_single_quoted(line: &str) -> bool {
        Self::raw_value_after_key(line)
            .is_some_and(|value| value.trim_start().starts_with('\''))
    }

    /// The text after the `=` (or after a fish `set -gx KEY`), still quoted.
    fn raw_value_after_key(line: &str) -> Option<&str> {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed
            .strip_prefix("set -gx ")
            .or_else(|| trimmed.strip_prefix("set -x "))
        {
            // fish: `set -gx KEY 'value'` — the value starts after the key and
            // may contain spaces.
            let mut parts = rest.splitn(2, char::is_whitespace);
            let _key = parts.next();
            return parts.next();
        }
        line.split_once('=').map(|(_, value)| value)
    }

    /// Whether the shell would expand the value exactly as it is written.
    ///
    /// The value text alone cannot answer this: `export TOKEN="$HOME"` is a
    /// template, but `export TOKEN="\$HOME"` and `export TOKEN="~/bin"` are
    /// literals that happen to contain `$` / `~`, and a single-quoted value is
    /// literal no matter what it contains. Reading the quote and escape state of
    /// the declaring line is what keeps a stored value from being turned into a
    /// template (or the reverse) by the next Apply.
    fn value_uses_expansion(line: &str) -> bool {
        let Some(raw) = Self::raw_value_after_key(line) else {
            return false;
        };
        let mut chars = raw.trim_start().chars().peekable();
        let (mut in_single, mut in_double, mut escaped, mut first) = (false, false, false, true);
        while let Some(c) = chars.next() {
            if escaped {
                escaped = false;
                first = false;
                continue;
            }
            if c == '\\' && !in_single {
                escaped = true;
                first = false;
                continue;
            }
            match c {
                '\'' if !in_double => {
                    in_single = !in_single;
                    first = false;
                }
                '"' if !in_single => {
                    in_double = !in_double;
                    first = false;
                }
                // `$VAR`, `${VAR}`, `$(cmd)` and `` `cmd` `` are evaluated inside
                // double quotes and outside them, but never inside single quotes.
                '$' | '`' if !in_single => return true,
                // A tilde only expands at the start of an unquoted word.
                '~' if first && !in_single && !in_double => return true,
                _ => first = false,
            }
        }
        false
    }

    /// Parse `~/.pam_environment`, whose syntax is `KEY [DEFAULT=]value`, not
    /// `KEY=value`. Reading it with the shell parser found no declarations at
    /// all, even though the file is part of the documented scan set.
    fn parse_pam_environment(content: &str) -> Vec<(String, String, usize)> {
        let mut results = Vec::new();
        for (idx, raw_line) in content.lines().enumerate() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.splitn(2, char::is_whitespace);
            let Some(key) = parts.next() else { continue };
            let Some(value) = parts.next() else { continue };
            let value = value.trim();
            let value = value.strip_prefix("DEFAULT=").unwrap_or(value);
            let value = value.trim_matches(&['"', '\''][..]);
            if is_valid_variable_name(key) {
                results.push((key.to_string(), value.to_string(), idx + 1));
            }
        }
        results
    }

    /// Standard Linux dotfile paths to scan for `export VAR=...` and `PATH=...` (Section 3.2.1)
    pub fn candidate_dotfiles(home: &Path) -> Vec<PathBuf> {
        let mut files = vec![
            PathBuf::from("/etc/environment"),
            PathBuf::from("/etc/profile"),
        ];

        for dir in [
            PathBuf::from("/etc/profile.d"),
            PathBuf::from("/etc/environment.d"),
            // systemd-user environment: this is where snapd appends `/snap/bin`,
            // which is how the same directory ends up in PATH twice on Ubuntu.
            PathBuf::from("/usr/lib/environment.d"),
        ] {
            if let Ok(rd) = fs::read_dir(&dir) {
                // `read_dir` order is filesystem-dependent. Sort so that when two
                // files in one directory declare the same PATH fragment, the
                // report always attributes it to the same file (and because
                // systemd itself applies these files in name order, that is also
                // the semantically correct order).
                let mut found: Vec<PathBuf> = rd
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|p| {
                        matches!(p.extension().and_then(|e| e.to_str()), Some("sh") | Some("conf"))
                    })
                    .collect();
                found.sort();
                files.extend(found);
            }
        }

        let env_d = home.join(".config/environment.d");
        if let Ok(rd) = fs::read_dir(&env_d) {
            let mut found: Vec<PathBuf> = rd
                .flatten()
                .map(|entry| entry.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("conf"))
                // `zz-env-doctor.conf` is our own mirror of `env.sh`; scanning it
                // would add a second, earlier-listed origin for every PATH entry
                // and make the app the reported source of its own output.
                .filter(|p| !is_app_generated_config(p))
                .collect();
            found.sort();
            files.extend(found);
        }

        files.extend([
            home.join(".pam_environment"),
            home.join(".profile"),
            home.join(".bash_profile"),
            home.join(".bashrc"),
            // rustup prepends `$HOME/.cargo/bin` here rather than in `.bashrc`.
            home.join(".cargo/env"),
            home.join(".zshenv"),
            home.join(".zshrc"),
            home.join(".config/fish/config.fish"),
            home.join(".config/env-doctor/env.sh"),
        ]);

        // The same file often has several names (`/usr/lib/environment.d/99-environment.conf`
        // is a symlink to `/etc/environment`). Keep the first, most canonical name so
        // the report cites the file a user would actually edit.
        let mut seen = HashSet::new();
        files.retain(|path| {
            let key = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
            seen.insert(key)
        });

        files
    }

    /// Extract the value of `KEY=...`, undoing the escaping a shell and this app
    /// use when writing it back.
    ///
    /// The naive "find the next quote" scan truncated any value containing an
    /// escaped quote. That matters in both directions: real dotfiles use
    /// `"$(find \"/etc/x\" ...)"`, and `env.sh` itself is written with `\"` and
    /// `'\''` escapes, so a truncated read would be written back as a shorter,
    /// broken value on the next Apply.
    fn parse_assignment_value(val: &str) -> String {
        let Some(quote) = val.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            let without_comment = val.split(" #").next().unwrap_or(val).trim();
            return without_comment.trim_matches(&['"', '\''][..]).to_string();
        };

        if quote == '\'' {
            // Inside single quotes everything is literal; the only escape this
            // writer emits is `'\''` for an embedded quote.
            let mut out = String::new();
            let mut rest = &val[1..];
            loop {
                let Some(end) = rest.find('\'') else {
                    out.push_str(rest);
                    return out;
                };
                out.push_str(&rest[..end]);
                match rest[end + 1..].strip_prefix("\\''") {
                    Some(tail) => {
                        out.push('\'');
                        rest = tail;
                    }
                    None => return out,
                }
            }
        }

        // Inside double quotes a backslash only escapes `$`, `` ` ``, `"`, `\`
        // and a newline; before anything else it is a literal backslash.
        let mut out = String::new();
        let mut escaped = false;
        for c in val[1..].chars() {
            if escaped {
                if matches!(c, '$' | '`' | '"' | '\\' | '\n') {
                    out.push(c);
                } else {
                    out.push('\\');
                    out.push(c);
                }
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                return out;
            } else {
                out.push(c);
            }
        }
        if escaped {
            out.push('\\');
        }
        out
    }

    /// Parse a dotfile content and extract `(key, value, 1_based_line_number)` declarations
    pub fn parse_dotfile_content(content: &str) -> Vec<(String, String, usize)> {
        Self::parse_dotfile_declarations(content)
            .into_iter()
            .map(|(key, value, line, _)| (key, value, line))
            .collect()
    }

    /// [`parse_dotfile_content`](Self::parse_dotfile_content), plus the exact
    /// text of the declaring line.
    ///
    /// The line is what says whether the value was expanded by the shell when it
    /// was read: one line can declare both `PATH` and a variable
    /// (`PATH="$HOME/bin:$PATH"; export JAVA_HOME=/opt/jdk`), and only the PATH
    /// part gets expanded. Looking the line up again by line number would then
    /// judge the variable by the PATH assignment.
    fn parse_dotfile_declarations(content: &str) -> Vec<(String, String, usize, String)> {
        let mut results = Vec::new();

        for (idx, raw_line) in content.lines().enumerate() {
            let line_no = idx + 1;
            let trimmed = raw_line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            // Support fish `set -gx KEY VALUE`
            if let Some(rest) = trimmed
                .strip_prefix("set -gx ")
                .or_else(|| trimmed.strip_prefix("set -x "))
            {
                let mut parts = rest.splitn(2, char::is_whitespace);
                if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
                    let clean_v = v.trim().trim_matches(&['"', '\''][..]).to_string();
                    results.push((k.trim().to_string(), clean_v, line_no, trimmed.to_string()));
                }
                continue;
            }

            let stmt = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
            if let Some(eq_pos) = stmt.find('=') {
                let key = stmt[..eq_pos].trim();
                if is_valid_variable_name(key) {
                    let val = stmt[eq_pos + 1..].trim();
                    let clean_val = Self::parse_assignment_value(val);
                    results.push((key.to_string(), clean_val, line_no, trimmed.to_string()));
                }
            }
        }

        results
    }

    /// Whether a file *declares* environment variables natively, i.e. a bare
    /// `KEY=value` line really does end up in the environment.
    ///
    /// `/etc/environment`, `environment.d/*.conf` and `~/.pam_environment` are
    /// lists of assignments, so they need no `export`. Shell startup scripts are
    /// programs instead: a bare `key=value` in them is a local variable.
    pub fn is_environment_style_file(path: &Path) -> bool {
        if path == Path::new("/etc/environment") {
            return true;
        }
        if path.file_name().and_then(|n| n.to_str()) == Some(".pam_environment") {
            return true;
        }
        path.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some("environment.d")
    }

    /// Names that are explicitly exported somewhere in `content`.
    ///
    /// Covers `export KEY=...`, the common two-step `KEY=...` followed by a bare
    /// `export KEY` (`/etc/profile.d/xdg_dirs_desktop_session.sh`) and conditional
    /// forms such as `[ -n "$X" ] && export X || unset X` (`debuginfod.sh`).
    pub fn exported_names_in(content: &str) -> HashSet<String> {
        let mut names = HashSet::new();
        for raw_line in content.lines() {
            let line = raw_line.trim();
            if line.starts_with('#') {
                continue;
            }
            // Fish's `set -gx NAME value` exports exactly like `export NAME=...`.
            let normalized = line
                .strip_prefix("set -gx ")
                .or_else(|| line.strip_prefix("set -x "))
                .map(|rest| format!("export {}", rest))
                .unwrap_or_else(|| line.to_string());
            let tokens: Vec<&str> = normalized.split_whitespace().collect();
            for (idx, token) in tokens.iter().enumerate() {
                let stripped = token
                    .trim_matches(|c: char| matches!(c, '"' | '\'' | ';' | '(' | ')' | '{' | '}'));
                if stripped != "export" {
                    continue;
                }
                let Some(next) = tokens.get(idx + 1) else { continue };
                let candidate = next.trim_matches(|c: char| matches!(c, '"' | '\'' | ';'));
                let name = candidate.split('=').next().unwrap_or(candidate);
                if is_valid_variable_name(name) {
                    names.insert(name.to_string());
                }
            }
        }
        names
    }

    /// Declarations in `path` that actually reach the environment.
    ///
    /// Shell scripts are full of `key=value` locals (`key`, `val`, `prefix`, …)
    /// that never leave the script. Listing those as "environment variables"
    /// inflates the reported count and shows the user noise they cannot act on,
    /// so a bare assignment in a shell script only counts when that file exports
    /// the name. Environment-style files keep every assignment, because there the
    /// assignment *is* the declaration.
    pub fn extract_environment_declarations(
        path: &Path,
        content: &str,
    ) -> Vec<(String, String, usize)> {
        Self::extract_environment_declarations_text(path, content)
            .into_iter()
            .map(|(key, value, line, _)| (key, value, line))
            .collect()
    }

    /// [`extract_environment_declarations`](Self::extract_environment_declarations),
    /// plus the text of the declaring line.
    ///
    /// The line keeps its quotes, so the caller can tell an unquoted declaration
    /// (`PATH=/opt/bin`) from a double-quoted one, which the shell had already
    /// expanded when the value was read.
    pub fn extract_environment_declarations_text(
        path: &Path,
        content: &str,
    ) -> Vec<(String, String, usize, String)> {
        // pam_env files use `KEY [DEFAULT=]value`, so they need their own reader
        // rather than the shell assignment parser.
        if path.file_name().and_then(|n| n.to_str()) == Some(".pam_environment") {
            return Self::parse_pam_environment(content)
                .into_iter()
                .map(|(key, value, line)| {
                    let text = content
                        .lines()
                        .nth(line.saturating_sub(1))
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    (key, value, line, text)
                })
                .collect();
        }

        let native = Self::is_environment_style_file(path);
        let exported = if native {
            HashSet::new()
        } else {
            Self::exported_names_in(content)
        };

        Self::parse_dotfile_declarations(content)
            .into_iter()
            // `PATH` is already exported by the login environment, so a bare
            // `PATH="$HOME/bin:$PATH"` in `.profile` (the stock Debian/Ubuntu
            // skeleton does exactly this, with no `export`) is a real
            // environment change. Filtering it out made those folders look like
            // session injections: no DEAD_PATH/EMPTY_DIR/UNEXPANDED checks, no
            // score penalty, and no "Declared in" attribution.
            .filter(|(key, _, _, _)| native || key == "PATH" || exported.contains(key))
            .collect()
    }

    /// Whether the shell had already expanded the value of `key` on this line.
    ///
    /// The parser stores the value *as written*. A double-quoted value (`"…"`)
    /// is a template the shell expands when it reads the file, while a
    /// single-quoted value is literal and an unquoted one has no quotes to
    /// expand either. Only the double-quoted form therefore needs expanding
    /// here, and an entry read from it has to be written back as data instead
    /// of copied as a template (see `Scope::Dotfile::expanded`).
    ///
    /// This has nothing to do with `$'…'` (ANSI-C quoting), which is not
    /// double quoting: `$'a\tb'` stays literal text.
    fn declaration_is_double_quoted(line: &str, key: &str) -> bool {
        let Some(raw) = Self::raw_value_after_key_for(key, line) else {
            return false;
        };
        let raw = raw.trim_start();
        raw.starts_with('"')
            && !raw.starts_with("$\"")
            && !raw.starts_with("$'")
    }

    /// The text after the `=` of `key` (or after a fish `set -gx key`).
    fn raw_value_after_key_for<'a>(key: &str, line: &'a str) -> Option<&'a str> {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed
            .strip_prefix("set -gx ")
            .or_else(|| trimmed.strip_prefix("set -x "))
        {
            let mut parts = rest.splitn(2, char::is_whitespace);
            let name = parts.next()?;
            return (name == key).then(|| parts.next().unwrap_or_default());
        }
        let stmt = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
        let (name, value) = stmt.split_once('=')?;
        (name.trim() == key).then_some(value)
    }

    /// Expand the `${VAR}`, `$VAR` and `~` forms a POSIX shell expands inside
    /// double quotes, using this process's environment.
    ///
    /// A double-quoted `PATH="$HOME/bin:$PATH"` is stored by the parser as the
    /// literal text `$HOME/bin:$PATH`. The live PATH only contains
    /// `/home/dev/bin`, so the text never matches and every folder declared that
    /// way was reported as a *session* entry: it lost its "Declared in" source,
    /// could not be recognized as a duplicate and was treated as runtime noise.
    ///
    /// Expansion happens before the PATH is split, exactly like the shell does
    /// it: a `$VAR` that itself contains a separator adds several folders.
    /// Quoting is not interpreted (the value was parsed without its quotes), and
    /// command substitution is deliberately left alone.
    pub fn expand_shell_value(value: &str, env: &HashMap<String, String>) -> String {
        let lookup = |name: &str| -> Option<&str> { env.get(name).map(String::as_str) };

        let chars: Vec<char> = value.chars().collect();
        let mut out = String::with_capacity(value.len());
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                // Keep the escape intact: `\$` is a literal dollar inside double
                // quotes, and the parser already removed the quotes.
                '\\' => {
                    out.push('\\');
                    if let Some(next) = chars.get(i + 1) {
                        out.push(*next);
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                // Only a leading `~` (start of the value or of a `:` component)
                // is expanded by the shell.
                '~' if i == 0 || chars[i - 1] == ':' => {
                    if matches!(chars.get(i + 1), None | Some('/') | Some(':')) {
                        match dirs::home_dir() {
                            Some(home) => out.push_str(&home.to_string_lossy()),
                            None => out.push('~'),
                        }
                        i += 1;
                    } else {
                        out.push('~');
                        i += 1;
                    }
                }
                '$' if chars.get(i + 1) == Some(&'{') => {
                    // Only the brace form that expands with no processing
                    // (`${HOME}`, `${PATH}`) is modelled. `${VAR:-x}`,
                    // `${VAR%%.*}` and every other form is left verbatim
                    // instead of guessing at its meaning.
                    let mut end = i + 2;
                    while end < chars.len()
                        && (chars[end].is_ascii_alphanumeric() || chars[end] == '_')
                    {
                        end += 1;
                    }
                    let first_is_blank = chars[i + 2] == '_' && end == i + 3;
                    let valid_name = end > i + 2
                        && (chars[i + 2].is_ascii_alphabetic() || first_is_blank);
                    if valid_name && chars.get(end) == Some(&'}') {
                        let name: String = chars[i + 2..end].iter().collect();
                        if let Some(replacement) = lookup(&name) {
                            out.push_str(replacement);
                        } else {
                            out.extend(&chars[i..=end]);
                        }
                        i = end + 1;
                    } else {
                        out.push('$');
                        i += 1;
                    }
                }
                '$' if chars.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic() || *c == '_') => {
                    let mut end = i + 1;
                    while end < chars.len()
                        && (chars[end].is_ascii_alphanumeric() || chars[end] == '_')
                    {
                        end += 1;
                    }
                    let name: String = chars[i + 1..end].iter().collect();
                    if let Some(replacement) = lookup(&name) {
                        out.push_str(replacement);
                    } else {
                        out.extend(&chars[i..end]);
                    }
                    i = end;
                }
                c => {
                    out.push(c);
                    i += 1;
                }
            }
        }
        out
    }

    /// Extract every PATH component from one `set -x` trace line.
    ///
    /// Bash prints `+ PATH=/first/bin:/second/bin:…` and zsh prints
    /// `+file:12> export PATH=/first/bin:…`; in both cases the first component
    /// sticks to the command text, so splitting at `PATH=` first is what keeps
    /// the interesting prepended directory from being silently dropped.
    pub fn trace_path_fragments(trace_line: &str) -> Vec<String> {
        let stripped = trace_line.trim_start_matches('+').trim();
        let Some((_, value)) = stripped.split_once("PATH=") else {
            return Vec::new();
        };
        value
            .split(':')
            .map(|fragment| fragment.trim().trim_matches(&['"', '\''][..]).to_string())
            .filter(|fragment| {
                !fragment.is_empty()
                    && fragment != "$PATH"
                    && fragment != "${PATH}"
                    && fragment != "$path"
                    && fragment != "${path}"
            })
            .collect()
    }

    /// Run a dynamic shell trace (`bash -xlc env` / `zsh -xlc env`) so a folder
    /// that is only added by a sourced script (nvm, sdkman, a profile.d snippet)
    /// can still be attributed to the file that adds it.
    pub fn trace_dynamic_shell_origins() -> HashMap<String, (PathBuf, usize)> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let shell_bin = if shell.contains("zsh") { "zsh" } else { "bash" };
        match Self::run_shell_trace(shell_bin) {
            Some(stderr_text) => Self::parse_trace_origins(&stderr_text),
            None => HashMap::new(),
        }
    }

    /// Run the traced login shell, bounded by a short timeout.
    ///
    /// A profile that prompts, waits on the network or loops must not hang the
    /// scan (and with it Apply/Restore, which load the environment too). The
    /// trace is only an attribution hint, so giving up after a few seconds is
    /// harmless; whatever the shell already wrote is still parsed.
    fn run_shell_trace(shell_bin: &str) -> Option<String> {
        let mut command = Command::new(shell_bin);
        command
            .args(["-xlc", "env"])
            .stdin(Stdio::null())
            // Only the `set -x` trace on stderr is used. It is drained by a
            // reader thread: a verbose login profile (oh-my-zsh, nvm, sdkman)
            // can easily write more than the pipe buffer, and a child blocking
            // on a full pipe would never exit.
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Put the shell in its own process group, so a timeout can stop a
            // foreground helper (`curl`, an `ssh` password prompt) that a
            // profile started; otherwise that helper keeps the stderr pipe open
            // and the trace cannot be collected.
            command.process_group(0);
        }

        let mut child = command.spawn().ok()?;
        let mut stderr = child.stderr.take()?;
        let buffer = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let (done_sender, done_receiver) = std::sync::mpsc::channel::<()>();

        let reader_buffer = std::sync::Arc::clone(&buffer);
        std::thread::spawn(move || {
            use std::io::Read;
            let mut chunk = [0u8; 8192];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        if let Ok(mut guard) = reader_buffer.lock() {
                            guard.extend_from_slice(&chunk[..read]);
                        }
                    }
                    Err(_) => break,
                }
            }
            // The receiver is gone after a timeout; ignore that.
            let _ = done_sender.send(());
        });

        let started = Instant::now();
        let mut timed_out = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if started.elapsed() >= Duration::from_secs(3) {
                        timed_out = true;
                        Self::kill_shell(&mut child);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => {
                    timed_out = true;
                    Self::kill_shell(&mut child);
                    break;
                }
            }
        }

        // On a normal exit the pipe closes quickly. After a timeout a helper
        // may still hold it, so only wait briefly and keep the prefix that was
        // collected rather than throwing the whole trace away.
        let _ = done_receiver.recv_timeout(if timed_out {
            Duration::from_millis(200)
        } else {
            Duration::from_millis(500)
        });

        let bytes = buffer.lock().ok()?.clone();
        if bytes.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
    }

    /// Stop the traced shell (and, on Unix, helpers in its process group).
    fn kill_shell(child: &mut std::process::Child) {
        #[cfg(unix)]
        unsafe {
            // The child was started in its own process group, so a negative pid
            // signals the whole group. Ignore failure: `child.kill()` below is
            // the fallback when `setpgid` did not take effect.
            let _ = libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Parse `set -x` stderr into a PATH-line -> declaring-file map.
    ///
    /// Bash writes `+ PATH=/first/bin:/second/bin:…` and zsh writes
    /// `+/path/to/file:12> export PATH=…`. The current script is tracked from
    /// `source` / `.` trace lines, and only the components added since the
    /// previous assignment are recorded: the rest of the value comes from the
    /// base PATH and belongs to whatever declared it earlier, not to the script
    /// that happens to re-assign the whole string.
    pub fn parse_trace_origins(stderr_text: &str) -> HashMap<String, (PathBuf, usize)> {
        let mut origins: HashMap<String, (PathBuf, usize)> = HashMap::new();
        let mut current_script: Option<PathBuf> = None;
        let mut previous_fragments: HashSet<String> = HashSet::new();
        let mut saw_assignment = false;

        for line in stderr_text.lines() {
            // Match source / `.` commands in trace output.
            if line.contains("source ") || line.contains(" . ") {
                for token in line.split_whitespace() {
                    let cleaned = token.trim_matches(&['\'', '"'][..]);
                    let expanded = if let Some(rest) = cleaned.strip_prefix("~/") {
                        match dirs::home_dir() {
                            Some(home) => home.join(rest),
                            None => continue,
                        }
                    } else {
                        PathBuf::from(cleaned)
                    };
                    if expanded.to_string_lossy().starts_with('/') {
                        current_script = Some(expanded);
                    }
                }
            }

            let assignment: Option<(String, Option<PathBuf>, usize)> =
                if let Some(rest) = line.strip_prefix('+') {
                    if rest.starts_with('/') {
                        // zsh: `+/path/to/file:12> export PATH=...`
                        let mut parsed = None;
                        if let Some(colon_pos) = rest.find(':') {
                            let file_part = &rest[..colon_pos];
                            let after_colon = &rest[colon_pos + 1..];
                            if let Some(gt_pos) = after_colon.find('>') {
                                if let Ok(line_num) = after_colon[..gt_pos].parse::<usize>() {
                                    let cmd_part = after_colon[gt_pos + 1..].trim();
                                    current_script = Some(PathBuf::from(file_part));
                                    if cmd_part.contains("PATH=") {
                                        parsed = Some((
                                            cmd_part.to_string(),
                                            Some(PathBuf::from(file_part)),
                                            line_num,
                                        ));
                                    }
                                }
                            }
                        }
                        parsed
                    } else {
                        // bash: `+ PATH=/first/bin:/second/bin:...`
                        let command = rest.trim_start();
                        if command.contains("PATH=") {
                            Some((command.to_string(), current_script.clone(), 1))
                        } else {
                            None
                        }
                    }
                } else if line.contains("PATH=") {
                    Some((line.to_string(), current_script.clone(), 1))
                } else {
                    None
                };

            let Some((command, script, line_number)) = assignment else {
                continue;
            };
            let fragments = Self::trace_path_fragments(&command);
            // The first assignment describes the initial PATH, so all of its
            // components belong to that file. A later assignment usually
            // re-states the whole PATH and only its new components were added
            // by the script being traced. The baseline is updated even when no
            // script has been sourced yet (the traced shell's initial PATH), so
            // the first scripted re-assignment does not re-credit every
            // inherited base folder.
            let added: Vec<String> = if saw_assignment {
                fragments
                    .iter()
                    .filter(|fragment| !previous_fragments.contains(*fragment))
                    .cloned()
                    .collect()
            } else {
                fragments.clone()
            };
            saw_assignment = true;
            previous_fragments = fragments.into_iter().collect();
            if let Some(script) = script {
                if !added.is_empty() {
                    origins.insert(format!("+ PATH={}", added.join(":")), (script, line_number));
                }
            }
        }

        origins
    }

    /// Backup a dotfile to `~/.local/share/env-doctor/backups/` with timestamp before editing (Section 4.3)
    pub fn backup_dotfile(file_path: &Path) -> Result<Option<PathBuf>, String> {
        if !file_path.exists() {
            return Ok(None);
        }
        let base = dirs::data_local_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        let backup_dir = base.join("env-doctor").join("backups");
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("Failed to create backup directory: {}", e))?;
        // A backup of `env.sh` or `.bashrc` can hold the same tokens the live
        // files hold, so the copies must not be readable by other accounts. The
        // database that stores snapshots is `0600` for the same reason.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&backup_dir, fs::Permissions::from_mode(0o700));
        }

        let file_name = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "dotfile".to_string());
        let ts = Local::now().format("%Y%m%d_%H%M%S");
        let dest = backup_dir.join(format!("{}.{}.bak", file_name, ts));

        fs::copy(file_path, &dest).map_err(|e| format!("Failed to backup dotfile: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o600));
        }
        Ok(Some(dest))
    }

    /// Ensure the Managed Block exists in `~/.bashrc` or `~/.zshrc` (Section 3.2.2)
    pub fn ensure_managed_block_in_rc(rc_path: &Path) -> Result<(), String> {
        // `.` rather than `source`: the same block is added to `~/.profile`,
        // which may be read by a POSIX shell (dash) that has no `source`.
        let snippet = format!(
            "\n{}\n[ -f \"$HOME/.config/env-doctor/env.sh\" ] && . \"$HOME/.config/env-doctor/env.sh\"\n{}\n",
            MANAGED_BLOCK_START, MANAGED_BLOCK_END
        );

        if rc_path.exists() {
            let content = fs::read_to_string(rc_path)
                .map_err(|e| format!("Failed to read {:?}: {}", rc_path, e))?;
            if content.contains(MANAGED_BLOCK_START) {
                return Ok(());
            }
            Self::backup_dotfile(rc_path)?;
            let mut updated = content;
            updated.push_str(&snippet);
            fs::write(rc_path, updated).map_err(|e| format!("Failed to write {:?}: {}", rc_path, e))?;
        }
        Ok(())
    }
}

impl PlatformEnvManager for LinuxEnvManager {
    fn load_environment(&self) -> Result<(Vec<PathEntry>, Vec<EnvVariable>, OsContext), String> {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        let mut env_lookup: HashMap<String, String> = HashMap::new();
        for (k, v) in crate::core::unicode_env_vars() {
            // Unix environment names are case-sensitive; folding `http_proxy`
            // into `HTTP_PROXY` would expand `${http_proxy}` with the wrong value.
            env_lookup.insert(k, v);
        }

        // Map variable name -> Scope::Dotfile, and PATH fragment -> every place it
        // was declared, in scan order. Keeping the whole list (not just the last
        // writer) is what lets the report tell a user that the *second* copy of
        // `/snap/bin` comes from `990-snapd.conf` while the first comes from
        // `/etc/environment`.
        //
        // Only declarations that really reach the environment are recorded
        // (`extract_environment_declarations`): shell-script locals must not
        // appear as environment variables.
        let mut var_origins: HashMap<String, (String, Scope, bool)> = HashMap::new();
        let mut path_origins: HashMap<String, Vec<(Scope, String)>> = HashMap::new();
        // `env.sh` is the app's own saved copy. It is still read so variables the
        // user added through the UI survive a restart, but its PATH declarations
        // are kept apart and used only as a fallback.
        let mut generated_path_origins: HashMap<String, Vec<(Scope, String)>> = HashMap::new();
        // (value, scope, the shell still expands the value as written)
        let mut generated_var_origins: HashMap<String, (String, Scope, bool)> = HashMap::new();

        for file_path in Self::candidate_dotfiles(&home) {
            if !file_path.exists() {
                continue;
            }
            let generated = is_app_generated_config(&file_path);
            if let Ok(content) = fs::read_to_string(&file_path) {
                for (key, val, line_number, line_text) in
                    Self::extract_environment_declarations_text(&file_path, &content)
                {
                    // The shell had already expanded a double-quoted value when
                    // it was read, so the parser holds `$HOME/bin:$PATH` while
                    // the live PATH holds `/home/dev/bin`. Expanding the stored
                    // text the way the shell would is what ties the folder back
                    // to the file that declared it.
                    let expanded = Self::declaration_is_double_quoted(&line_text, &key);
                    let scope = Scope::Dotfile {
                        file_path: file_path.clone(),
                        line_number,
                        expanded,
                    };
                    // The quote and escape style of the declaring line states the
                    // intent: `export TOKEN='pa$$word'` and
                    // `export TOKEN="\$HOME"` are literals for the shell, while
                    // `export TOKEN="$HOME"` and `export A=~/bin` must stay
                    // templates. Deciding from the value text alone turned the
                    // literals into templates on the next Apply.
                    let expandable = Self::value_uses_expansion(&line_text);
                    if key == "PATH" {
                        let target = if generated {
                            &mut generated_path_origins
                        } else {
                            &mut path_origins
                        };
                        let text = if expanded {
                            Self::expand_shell_value(&val, &env_lookup)
                        } else {
                            val
                        };
                        Self::record_path_origins(target, &text, &scope, &env_lookup);
                    } else if generated {
                        generated_var_origins.insert(key, (val, scope, expandable));
                    } else {
                        var_origins.insert(key, (val, scope, expandable));
                    }
                }
            }
        }

        // `env.sh` also wins when it holds a *different* value (the user edited
        // the variable in the app and applied it), but an identical copy must not
        // hide the real declaration in `/etc/profile.d` or `~/.bashrc`.
        for (key, (value, scope, expandable)) in generated_var_origins {
            let keep_real_source = var_origins
                .get(&key)
                .is_some_and(|(existing, _, _)| *existing == value);
            if !keep_real_source {
                var_origins.insert(key, (value, scope, expandable));
            }
        }

        // Merge with dynamic shell trace origins if any
        for (trace_line, (script_path, line_number)) in Self::trace_dynamic_shell_origins() {
            // The app's own env.sh is already parsed statically, with correct
            // line numbers. The trace only knows the line where the shell
            // sourced it (line 1 of its own copy), so letting it in would both
            // duplicate the origin and make the "Declared in" link point at the
            // wrong line for entries the app added.
            if is_app_generated_config(&script_path) {
                continue;
            }
            for fragment in Self::trace_path_fragments(&trace_line) {
                // The trace writes the *configured* text (`$HOME/.cargo/bin`),
                // while the live PATH contains the expanded form, so register
                // both spellings exactly like the static file scan does.
                //
                // The live PATH component is the expanded directory, so the
                // origin has to say it is data: writing the template back would
                // expand it differently under the shell that reads `env.sh`.
                let live = Self::expand_shell_value(&fragment, &env_lookup);
                let live = expand_path_variables(&live, &env_lookup);
                if !live.is_absolute() {
                    continue;
                }
                let expanded_scope = Scope::Dotfile {
                    file_path: script_path.clone(),
                    line_number,
                    expanded: true,
                };
                let literal_scope = Scope::Dotfile {
                    file_path: script_path.clone(),
                    line_number,
                    expanded: false,
                };
                for (key, scope) in [
                    (live.to_string_lossy().to_string(), expanded_scope),
                    (fragment.clone(), literal_scope),
                ] {
                    let origins = path_origins.entry(key).or_default();
                    if !origins.iter().any(|(seen, _)| *seen == scope) {
                        origins.push((scope, fragment.clone()));
                    }
                }
            }
        }

        // Finally make the generated file a *fallback* source: real declarations
        // (static files and the dynamic trace) were recorded first, so a
        // directory written both by `.bashrc` and by the app keeps pointing at
        // `.bashrc`.
        for (key, origins) in generated_path_origins {
            path_origins.entry(key).or_default().extend(origins);
        }

        let raw_path = std::env::var("PATH").unwrap_or_default();
        let mut path_entries = Vec::new();
        // How many times a fragment has already been seen, so repeated entries such
        // as the two `/snap/bin` copies each report their own declaring file.
        let mut origin_use: HashMap<String, usize> = HashMap::new();

        for (idx, part) in raw_path
            .split(':')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .enumerate()
        {
            let resolved = expand_path_variables(part, &env_lookup);
            let exists = resolved.exists() && resolved.is_dir();
            let resolved_str = resolved.to_string_lossy().to_string();

            // An entry we cannot tie back to a config file was contributed by the
            // running process/session (`npm run` injecting `node_modules/.bin`, a
            // tool manager prepending a directory). Calling it "User" or "System"
            // would claim the user configured it, so it is reported as a session
            // entry instead and the analyzer leaves it alone.
            let origin_key = if path_origins.contains_key(part) {
                part.to_string()
            } else if path_origins.contains_key(&resolved_str) {
                resolved_str.clone()
            } else {
                String::new()
            };

            let chosen = path_origins.get(&origin_key).map(|origins| {
                let seen = origin_use.entry(origin_key.clone()).or_insert(0);
                let picked = origins.get(*seen).or_else(|| origins.last());
                *seen += 1;
                picked
            });

            let (scope, source_text) = match chosen.flatten() {
                Some((scope, source)) => (scope.clone(), Some(source.clone())),
                None => (Scope::Process, None),
            };

            path_entries.push(PathEntry {
                id: format!("lnx-{}-{}", idx, Uuid::new_v4()),
                raw_value: part.to_string(),
                resolved_value: resolved,
                scope,
                source_text,
                exists,
                executable_count: 0,
                issues: Vec::new(),
            });
        }

        let mut variables = Vec::new();
        let mut seen_keys = HashSet::new();

        for (k, (val, scope, expandable)) in var_origins {
            seen_keys.insert(k.clone());
            variables.push(EnvVariable {
                key: k,
                value: val,
                // Read from the declaring line (quotes and escapes), not from
                // the text: `pa$$ $5` is literal when it was single-quoted, and
                // `"\$HOME"` / `"~/bin"` are literals that merely contain `$`
                // or `~`, while an unquoted `~/bin` and `"$HOME"` expand.
                is_expandable: expandable,
                scope,
                is_modified: false,
            });
        }

        for (k, v) in crate::core::unicode_env_vars() {
            if k == "PATH" || seen_keys.contains(&k) {
                continue;
            }
            variables.push(EnvVariable {
                key: k,
                value: v.clone(),
                is_expandable: v.contains('$'),
                scope: Scope::Process,
                is_modified: false,
            });
        }

        variables.sort_by(|a, b| a.key.to_lowercase().cmp(&b.key.to_lowercase()));

        let total_path_length: usize = path_entries.iter().map(|p| p.raw_value.len() + 1).sum();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

        let os_context = OsContext {
            os_name: Self::distro_name(),
            os_version: Self::distro_version(),
            arch: std::env::consts::ARCH.to_string(),
            total_path_length,
            max_path_length: 4096,
            is_elevated: std::env::var("USER").map(|u| u == "root").unwrap_or(false),
            shell,
            home_dir: home.to_string_lossy().to_string(),
        };

        Ok((path_entries, variables, os_context))
    }

    fn apply_environment(
        &self,
        path_entries: &[PathEntry],
        variables: &[EnvVariable],
        _allow_uac_elevation: bool,
    ) -> Result<(bool, Vec<String>), String> {
        let home = dirs::home_dir().ok_or_else(|| "Could not determine user home directory.".to_string())?;
        let env_doctor_dir = home.join(".config").join("env-doctor");
        fs::create_dir_all(&env_doctor_dir)
            .map_err(|e| format!("Failed to create ~/.config/env-doctor: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&env_doctor_dir, fs::Permissions::from_mode(0o700));
        }

        let env_sh_path = env_doctor_dir.join("env.sh");
        Self::backup_dotfile(&env_sh_path)?;

        let mut lines = Vec::new();
        lines.push("#!/usr/bin/env sh".to_string());
        lines.push("# Managed by Env & PATH Doctor — Do not edit manually".to_string());
        lines.push(format!(
            "# Last updated: {}",
            Local::now().format("%Y-%m-%d %H:%M:%S")
        ));
        lines.push(String::new());

        let mut skipped_variables: Vec<String> = Vec::new();
        let mut invalid_variables: Vec<String> = Vec::new();
        let mut ignored_path_variables = 0usize;
        for var in variables {
            if var.scope == Scope::Process {
                continue;
            }
            if var.key == "PATH" {
                // `PATH` is written from the PATH entries, not from a variable
                // row. Say so instead of silently dropping an imported/added
                // row that the user can see in the editor.
                ignored_path_variables += 1;
                continue;
            }
            // The key ends up in `export <key>=...`. Imported profiles and
            // hand-edited names are untrusted input: a key containing `;`, a
            // newline or whitespace would inject another shell command into
            // env.sh and run it every time a new shell starts.
            if !is_valid_variable_name(&var.key) {
                invalid_variables.push(var.key.clone());
                continue;
            }
            match Self::safe_variable_line(var) {
                Some(line) => lines.push(line),
                None => skipped_variables.push(var.key.clone()),
            }
        }

        // Session entries (tool/package-manager injections) are usually *live*
        // views of the current shell: `~/.nvm/.../bin` must be preserved or `node`
        // disappears from new shells. Two kinds are left out instead: entries
        // that do not even exist on disk (they can never resolve for anyone) and
        // project-local folders such as `node_modules/.bin`, which only exist
        // while one project is open. `should_persist_path_entry` re-stats the
        // folder: a restored snapshot carries a stale `exists` flag.
        let contains_line_break =
            |entry: &PathEntry| entry.raw_value.contains('\n') || entry.raw_value.contains('\r');
        let persisted: Vec<&PathEntry> = path_entries
            .iter()
            .filter(|p| Self::should_persist_path_entry(p) && !contains_line_break(p))
            .collect();
        let mut dropped_dead = 0usize;
        let mut dropped_project = 0usize;
        for entry in path_entries.iter().filter(|p| p.scope == Scope::Process) {
            let live = entry.resolved_value.exists() && entry.resolved_value.is_dir();
            if !live {
                dropped_dead += 1;
            } else if Self::is_build_injected_dir(&entry.resolved_value) {
                dropped_project += 1;
            }
        }
        let dropped_multiline = path_entries
            .iter()
            .filter(|p| Self::should_persist_path_entry(p) && contains_line_break(p))
            .count();
        let kept_session = persisted
            .iter()
            .filter(|p| p.scope == Scope::Process)
            .count();

        if persisted.is_empty() {
            return Err(
                "Safe Guard: every remaining PATH entry would be filtered out, so the saved PATH would be empty; refusing to write it."
                    .to_string(),
            );
        }
        // The guard must inspect the *persisted* list: a dead session `/bin`
        // satisfies a check over the staged entries and is then dropped, which
        // would write a PATH without the system binaries. Secondary folders such
        // as `/usr/sbin` are not enough either.
        if !persisted
            .iter()
            .any(|p| is_core_system_bin_dir(&p.raw_value, &p.resolved_value))
        {
            return Err(
                "Safe Guard: Critical Linux system path (/usr/bin or /bin) is missing; operation blocked."
                    .to_string(),
            );
        }

        let mut warnings = Vec::new();
        if dropped_dead > 0 {
            warnings.push(format!(
                "Left out {} session PATH {} that {} on disk: the running process added {}, so saving {} would only bake a broken folder into your configuration.",
                dropped_dead,
                if dropped_dead == 1 { "entry" } else { "entries" },
                if dropped_dead == 1 { "no longer exists" } else { "no longer exist" },
                if dropped_dead == 1 { "it" } else { "them" },
                if dropped_dead == 1 { "it" } else { "them" }
            ));
        }
        if dropped_project > 0 {
            warnings.push(format!(
                "Left out {} session PATH {} that a build tool injected for a single command (a project's `node_modules/.bin`, npm's `node-gyp-bin` or a Python virtualenv). Such folders only work while that project or tool is active, so saving them would leave dead folders in your PATH. They stay listed under \"Session PATH entries\" in the Doctor tab.",
                dropped_project,
                if dropped_project == 1 { "entry" } else { "entries" }
            ));
        }
        if kept_session > 0 {
            warnings.push(format!(
                "Kept {} session PATH {} that {} added by the current session (a tool manager or login shell) rather than a config file, so those tools keep working. Run the tool's own installer if you want them independent of this app.",
                kept_session,
                if kept_session == 1 { "entry" } else { "entries" },
                if kept_session == 1 { "was" } else { "were" }
            ));
        }
        if dropped_multiline > 0 {
            warnings.push(format!(
                "Left out {} PATH {} whose value contains a line break: env.sh is read back line by line, so the next scan would truncate the saved PATH. Remove the literal line break from that path and apply again.",
                dropped_multiline,
                if dropped_multiline == 1 { "entry" } else { "entries" }
            ));
        }
        if !invalid_variables.is_empty() {
            warnings.push(format!(
                "Left {} variable{} with an invalid name out of env.sh ({}). A shell name may contain only letters, digits and `_` and cannot start with a digit; rename {} in the Variables tab and apply again.",
                invalid_variables.len(),
                if invalid_variables.len() == 1 { "" } else { "s" },
                invalid_variables
                    .iter()
                    .map(|key| format!("`{}`", key.replace('`', "'")))
                    .collect::<Vec<_>>()
                    .join(", "),
                if invalid_variables.len() == 1 { "it" } else { "them" }
            ));
        }
        if ignored_path_variables > 0 {
            warnings.push(format!(
                "Left out {} variable row named `PATH`: the PATH is written from the PATH entries, not from a variable. Edit it in the PATH editor instead.",
                ignored_path_variables
            ));
        }
        if !skipped_variables.is_empty() {
            warnings.push(format!(
                "Left {} variable{} out of env.sh ({}): the recorded declaration cannot be replayed safely in a new shell (it depends on a value this session does not have, it contains a line break, or it would overwrite the value that is active now). Your profile keeps setting {} as before.",
                skipped_variables.len(),
                if skipped_variables.len() == 1 { "" } else { "s" },
                skipped_variables
                    .iter()
                    .map(|key| format!("`{}`", key.replace('`', "'")))
                    .collect::<Vec<_>>()
                    .join(", "),
                if skipped_variables.len() == 1 { "it" } else { "them" }
            ));
        }

        // A PATH component is the *directory* that was searched. An entry read
        // from a shell-redirecting declaration (`PATH="$HOME/x:$PATH"`) carries
        // the resolved directory, and writing that directory back unchanged is
        // always correct — replaying the declaring text could expand again to
        // something else in the shell that sources `env.sh` (for instance
        // `PATH="$TMPDIR/bin:$PATH"` would silently drop the folder in a session
        // where `TMPDIR` is unset, while the live PATH held the expanded one).
        let join_component = |entry: &PathEntry| -> String {
            let text = entry.raw_value.trim();
            match &entry.scope {
                Scope::Dotfile { expanded: true, .. } => {
                    let resolved = entry.resolved_value.to_string_lossy();
                    if resolved.is_empty() {
                        text.to_string()
                    } else {
                        resolved.to_string()
                    }
                }
                _ => Self::as_shell_text(text),
            }
        };
        let joined_path = persisted
            .iter()
            .map(|p| join_component(p))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(":");
        lines.push(format!(
            "export PATH={}",
            Self::shell_quote_path(&joined_path)
        ));
        lines.push(String::new());

        fs::write(&env_sh_path, lines.join("\n"))
            .map_err(|e| format!("Failed to write env.sh: {}", e))?;
        // The file can contain variable values (tokens, API keys), so keep it
        // private to the owner instead of relying on the process umask.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&env_sh_path, fs::Permissions::from_mode(0o600));
        }

        // Inject the managed block into the files new shells actually read.
        // `~/.profile` also covers non-interactive login shells (`ssh host cmd`),
        // where bash's `~/.bashrc` returns early because it is not interactive.
        //
        // These are warnings, not failures: env.sh has already been written, so
        // reporting "Apply failed" would be wrong, and a read-only `.bashrc`
        // must not stop `zz-env-doctor.conf` (which GUI sessions use) from being
        // updated.
        let bashrc = home.join(".bashrc");
        let zshrc = home.join(".zshrc");
        let profile = home.join(".profile");
        let mut interactive_loader = false;
        for (rc_path, label) in [
            (&bashrc, "~/.bashrc"),
            (&zshrc, "~/.zshrc"),
            (&profile, "~/.profile"),
        ] {
            if rc_path.exists() && rc_path != &profile {
                interactive_loader = true;
            }
            if let Err(err) = Self::ensure_managed_block_in_rc(rc_path) {
                warnings.push(format!(
                    "Saved the new PATH, but could not add the loader block to {}: {}. Shells that already source ~/.config/env-doctor/env.sh keep working, and GUI sessions still read ~/.config/environment.d/zz-env-doctor.conf.",
                    label, err
                ));
            }
        }
        if !interactive_loader {
            // `ensure_managed_block_in_rc` only touches files that already
            // exist: creating a `.zshrc` for a bash user would add an unrelated
            // file. But without a shell rc, no *interactive* shell reads env.sh,
            // and the user must be told instead of getting a silent no-op.
            warnings.push(format!(
                "Saved the new PATH, but neither ~/.bashrc nor ~/.zshrc exists{}, so an interactive shell has no loader block to source ~/.config/env-doctor/env.sh. Create one of those files (or source env.sh yourself) to load the saved PATH there; ~/.profile covers login shells and GUI sessions already read ~/.config/environment.d/zz-env-doctor.conf.",
                if profile.exists() { "" } else { " and ~/.profile is missing too" }
            ));
        }

        // Also write systemd user environment.d config for GUI sessions.
        //
        // The file is named `zz-` so it is parsed after `990-snapd.conf`: the
        // PATH the user reviewed in the UI must be the final one, and snapd's
        // file only *appends* `/snap/bin` (which is already in the reviewed
        // list), so being read first would add a duplicate instead.
        let systemd_env_dir = home.join(".config").join("environment.d");
        match fs::create_dir_all(&systemd_env_dir) {
            Ok(()) => {
                let conf_path = systemd_env_dir.join("zz-env-doctor.conf");
                // The environment.d parser reads the rest of the line as the
                // value, strips one pair of surrounding quotes and interprets
                // backslash escapes, so the PATH is written quoted and escaped.
                let systemd_value = Self::systemd_env_value(&joined_path);
                match fs::write(&conf_path, format!("PATH={}\n", systemd_value)) {
                    Ok(()) => {
                        // Remove the earlier file name so two PATH assignments
                        // don't fight, but only after the replacement exists.
                        let _ = fs::remove_file(systemd_env_dir.join("99-env-doctor.conf"));
                    }
                    Err(err) => warnings.push(format!(
                        "Saved the new PATH for new shells, but could not update {}: {}. GUI sessions keep the previous PATH.",
                        conf_path.display(),
                        err
                    )),
                }
            }
            Err(err) => warnings.push(format!(
                "Saved the new PATH for new shells, but could not create {}: {}. GUI sessions keep the previous PATH.",
                systemd_env_dir.display(),
                err
            )),
        }

        // `false`: unlike Windows, Linux has no `WM_SETTINGCHANGE`-style broadcast
        // to already-running processes. New shells pick the files up on their own.
        Ok((false, warnings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a variable without the scope noise.
    fn var(value: &str, is_expandable: bool) -> EnvVariable {
        EnvVariable {
            key: "DEMO".to_string(),
            value: value.to_string(),
            is_expandable,
            scope: Scope::Dotfile {
                file_path: std::path::PathBuf::from("/home/dev/.profile"),
                line_number: 1,
                expanded: true,
            },
            is_modified: false,
        }
    }

    #[test]
    fn literal_values_are_single_quoted_so_shell_syntax_stays_literal() {
        // `$5` must not expand to the empty string, and a trailing backslash
        // must not swallow the closing quote (which would break every shell).
        assert_eq!(
            LinuxEnvManager::env_sh_variable_line(&var("pa$$ $5 \\", false)),
            "export DEMO='pa$$ $5 \\'"
        );
        // An embedded single quote is escaped the POSIX way.
        assert_eq!(
            LinuxEnvManager::env_sh_variable_line(&var("it's", false)),
            "export DEMO='it'\\''s'"
        );
    }

    #[test]
    fn systemd_environment_files_escape_quotes_and_backslashes() {
        // systemd's environment.d parser strips one pair of surrounding quotes
        // and interprets backslash escapes, so an unescaped path would reach the
        // GUI session with a different value than the user reviewed.
        assert_eq!(
            LinuxEnvManager::systemd_env_value("/usr/bin"),
            "\"/usr/bin\""
        );
        assert_eq!(
            LinuxEnvManager::systemd_env_value("/opt/My Tools/bin"),
            "\"/opt/My Tools/bin\""
        );
        assert_eq!(
            LinuxEnvManager::systemd_env_value("/opt/a\"b"),
            "\"/opt/a\\\"b\""
        );
        assert_eq!(
            LinuxEnvManager::systemd_env_value("/opt/a\\b"),
            "\"/opt/a\\\\b\""
        );
    }

    #[test]
    fn invalid_variable_names_cannot_inject_shell_commands() {
        // An imported profile or a hand-edited key ends up in
        // `export <key>=...`; anything but [A-Za-z_][A-Za-z0-9_]* would run a
        // second command every time a new shell sources env.sh.
        let mut command = var("x", false);
        command.key = "SAFE; touch /tmp/env-doctor-pwned".to_string();
        assert_eq!(LinuxEnvManager::safe_variable_line(&command), None);

        let mut newline = var("x", false);
        newline.key = "A\nB".to_string();
        assert_eq!(LinuxEnvManager::safe_variable_line(&newline), None);

        let mut leading_digit = var("x", false);
        leading_digit.key = "1ABC".to_string();
        assert_eq!(LinuxEnvManager::safe_variable_line(&leading_digit), None);

        let mut valid = var("x", false);
        valid.key = "_GOOD1".to_string();
        assert!(LinuxEnvManager::safe_variable_line(&valid).is_some());
    }

    #[test]
    fn multi_line_values_are_not_written_to_env_sh() {
        // `env.sh` stores one variable per line and is read back line by line.
        // Writing a multi-line value would survive one shell, but the next scan
        // would see only the first line and the following Apply would overwrite
        // the rest. Skipping is safer than truncating the user's value.
        let mut multiline = var("first line\nsecond line", false);
        multiline.key = "ENV_DOCTOR_TEST_MULTI".to_string();
        assert_eq!(LinuxEnvManager::safe_variable_line(&multiline), None);

        let mut crlf = var("first\r\nsecond", true);
        crlf.key = "ENV_DOCTOR_TEST_CRLF".to_string();
        crlf.is_modified = true;
        assert_eq!(LinuxEnvManager::safe_variable_line(&crlf), None);

        // Ordinary spaces are not line breaks and must keep working.
        let mut spaced = var("one line with spaces", false);
        spaced.key = "ENV_DOCTOR_TEST_SPACES".to_string();
        assert!(LinuxEnvManager::safe_variable_line(&spaced).is_some());
    }

    #[test]
    fn values_already_saved_in_env_sh_survive_the_next_apply() {
        // Apply cannot change the environment of the already-running app, so a
        // saved value can legitimately differ from `std::env` until restart.
        // Comparing it would silently delete the user's setting next time.
        std::env::set_var("ENV_DOCTOR_TEST_APPLIED", "/old/toolchain");
        // The fallback keeps the value replayable even where `HOME` is not part
        // of the process environment (the Windows test runner); the point of the
        // test is the already-written env.sh value, not the variable it names.
        let mut saved = var("${HOME:-/home/dev}/.new-toolchain", true);
        saved.key = "ENV_DOCTOR_TEST_APPLIED".to_string();
        saved.scope = Scope::Dotfile {
            file_path: PathBuf::from("/home/dev/.config/env-doctor/env.sh"),
            line_number: 5,
            expanded: true,
        };
        assert!(
            LinuxEnvManager::safe_variable_line(&saved).is_some(),
            "a value already written to env.sh must survive the next Apply"
        );

        // Structural guards still apply to every value: a reference to an unset
        // variable with no fallback is not replayed even from env.sh, and even
        // when the value was edited by the user (or came from a profile).
        std::env::remove_var("ENV_DOCTOR_TEST_APPLIED");
        let mut conditional = var("${ENV_DOCTOR_TEST_UNSET_9F3%.*}.UTF-8", true);
        conditional.key = "LC_CTYPE".to_string();
        conditional.scope = saved.scope.clone();
        conditional.is_modified = true;
        assert_eq!(LinuxEnvManager::safe_variable_line(&conditional), None);
    }

    #[test]
    fn conditional_assignments_are_not_replayed_with_undefined_variables() {
        // `env.sh` is sourced by every new shell. `cedilla-portuguese.sh` guards
        // this export with an `if`, but the scanner records only the assignment:
        // on an English system `LC_IDENTIFICATION` is unset, so replaying it
        // exports the invalid locale `.UTF-8` and every shell prints
        // `setlocale: LC_CTYPE: cannot change locale`.
        let mut conditional = var("${ENV_DOCTOR_TEST_UNSET_9F3%.*}.UTF-8", true);
        conditional.key = "LC_CTYPE".to_string();
        assert_eq!(LinuxEnvManager::safe_variable_line(&conditional), None);

        // A `:-` fallback is self-contained and stays.
        let mut fallback = var("${ENV_DOCTOR_TEST_UNSET_9F3:-/usr/share}", true);
        fallback.key = "ENV_DOCTOR_TEST_OK".to_string();
        assert!(LinuxEnvManager::safe_variable_line(&fallback).is_some());

        // An expression that reproduces the live value is saved as written.
        std::env::set_var("ENV_DOCTOR_TEST_LIVE", "/tmp/live");
        let mut matching = var("${ENV_DOCTOR_TEST_UNSET_9F3:-/tmp/live}", true);
        matching.key = "ENV_DOCTOR_TEST_LIVE".to_string();
        assert!(LinuxEnvManager::safe_variable_line(&matching).is_some());

        // A conditional branch must not overwrite the value that is active now
        // (this is how `/etc/profile.d/xdg_dirs_desktop_session.sh` sets
        // `XDG_CONFIG_DIRS` before the desktop session narrows it again).
        let mut stale = var("${ENV_DOCTOR_TEST_MISSING_41C:-/etc/xdg}", true);
        stale.key = "ENV_DOCTOR_TEST_LIVE".to_string();
        assert_eq!(LinuxEnvManager::safe_variable_line(&stale), None);

        // A backslash-escaped dollar and command substitution are not variable
        // references and must not be dropped.
        let mut literal = var("\\$HOME $(date)", true);
        literal.key = "ENV_DOCTOR_TEST_LITERAL".to_string();
        assert!(LinuxEnvManager::safe_variable_line(&literal).is_some());
    }

    #[test]
    fn tilde_is_only_rewritten_at_the_start_of_a_path() {
        assert_eq!(LinuxEnvManager::as_shell_text("~/scripts"), "$HOME/scripts");
        assert_eq!(LinuxEnvManager::as_shell_text("~"), "$HOME");
        assert_eq!(LinuxEnvManager::as_shell_text("/opt/~user/bin"), "/opt/~user/bin");
        assert_eq!(LinuxEnvManager::as_shell_text("$HOME/bin"), "$HOME/bin");
    }

    #[test]
    fn config_templates_keep_expanding_and_tildes_become_home() {
        assert_eq!(
            LinuxEnvManager::env_sh_variable_line(&var("${XDG_DATA_DIRS:-/usr/share}", true)),
            "export DEMO=\"${XDG_DATA_DIRS:-/usr/share}\""
        );
        // In double quotes `~` would stay literal; the config line `K=~/bin`
        // did expand it, so write the equivalent `$HOME` form.
        assert_eq!(
            LinuxEnvManager::env_sh_variable_line(&var("~/bin", true)),
            "export DEMO=\"$HOME/bin\""
        );
        // A backslash is doubled so the quoting can never be escaped.
        assert_eq!(
            LinuxEnvManager::env_sh_variable_line(&var("a\\b", true)),
            "export DEMO=\"a\\\\b\""
        );
    }

    #[test]
    fn a_double_quoted_value_is_expanded_the_way_the_shell_expands_it() {
        // `PATH="$HOME/bin:$PATH"` is stored as written, but the live PATH holds
        // `/home/dev/bin`. Expanding the text is what ties the folder back to the
        // file that declared it (before this, every such folder was reported as
        // a session entry with no source).
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/home/dev".to_string());
        env.insert("TOOLS".to_string(), "/opt/a:/opt/b".to_string());
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        let expand = |value: &str| LinuxEnvManager::expand_shell_value(value, &env);

        assert_eq!(expand("$HOME/bin:$PATH"), "/home/dev/bin:/usr/bin:/bin");
        assert_eq!(expand("${HOME}/bin"), "/home/dev/bin");
        assert_eq!(expand("$TOOLS/bin"), "/opt/a:/opt/b/bin");

        // A leading `~` (and a `~` after a separator) is expanded, a `~` in the
        // middle of a component is not.
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert_eq!(expand("~/bin"), format!("{home}/bin"));
        assert_eq!(expand("/opt/~user/bin"), "/opt/~user/bin");

        // Shell syntax this helper does not model is left alone instead of
        // being guessed at: a `${VAR:-x}` default, command substitution, `$$`
        // and an escaped dollar.
        assert_eq!(expand("${MISSING:-/opt/x}/bin"), "${MISSING:-/opt/x}/bin");
        assert_eq!(expand("/opt/$(id)/bin"), "/opt/$(id)/bin");
        assert_eq!(expand("pa$$word"), "pa$$word");
        assert_eq!(expand(r"\$HOME/bin"), r"\$HOME/bin");
    }

    #[test]
    fn only_double_quoted_declarations_are_expanded() {
        // The parser keeps the value *as written*, so the quotes decide whether
        // what it holds is a template the shell already expanded.
        assert!(LinuxEnvManager::declaration_is_double_quoted(
            "export PATH=\"$HOME/bin:$PATH\"",
            "PATH"
        ));
        assert!(LinuxEnvManager::declaration_is_double_quoted(
            "PATH=\"$HOME/bin:$PATH\"",
            "PATH"
        ));
        assert!(LinuxEnvManager::declaration_is_double_quoted(
            "set -gx PATH \"$HOME/bin\"",
            "PATH"
        ));

        for (line, key) in [
            // A literal: the shell does not expand inside single quotes.
            ("export PATH='$HOME/bin:$PATH'", "PATH"),
            // No quotes at all: the text is stored as written.
            ("export PATH=$HOME/bin:$PATH", "PATH"),
            // ANSI-C quoting is not double quoting.
            ("export PATH=$'a\\tb'", "PATH"),
            // `PATH` is declared on this line, but the question is about another
            // key, whose own value is not quoted.
            (
                "PATH=\"$HOME/bin:$PATH\"; export JAVA_HOME=/opt/jdk",
                "JAVA_HOME",
            ),
            ("env.d line without an assignment", "PATH"),
        ] {
            assert!(
                !LinuxEnvManager::declaration_is_double_quoted(line, key),
                "{line} must not be treated as an expanded declaration"
            );
        }
    }

    #[test]
    fn a_double_quoted_path_is_attributed_to_its_file() {
        // End-to-end shape of the bug: the value the parser returns is the text,
        // and the folders are what the live PATH contains.
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/home/dev".to_string());
        let declarations = LinuxEnvManager::extract_environment_declarations_text(
            Path::new("/home/dev/.profile"),
            "PATH=\"$HOME/.local/bin:$PATH\"\n",
        );
        let (key, value, line, text) = &declarations[0];
        assert_eq!((key.as_str(), *line), ("PATH", 1));
        assert_eq!(value, "$HOME/.local/bin:$PATH");

        let mut origins: HashMap<String, Vec<(Scope, String)>> = HashMap::new();
        let scope = Scope::Dotfile {
            file_path: PathBuf::from("/home/dev/.profile"),
            line_number: *line,
            expanded: true,
        };
        let expanded_value = LinuxEnvManager::expand_shell_value(value, &env);
        LinuxEnvManager::record_path_origins(&mut origins, &expanded_value, &scope, &env);
        assert!(
            origins.contains_key("/home/dev/.local/bin"),
            "the expanded folder must be recorded as declared, got {origins:?}"
        );
        assert!(LinuxEnvManager::declaration_is_double_quoted(text, key));
    }

    #[test]
    fn trace_fragments_keep_the_prepended_directory() {
        // Bash `set -x`: the command text is glued to the first component.
        assert_eq!(
            LinuxEnvManager::trace_path_fragments("+ PATH=/opt/tool/bin:/usr/bin:$PATH"),
            vec!["/opt/tool/bin", "/usr/bin"]
        );
        // zsh passes only the command part, without the leading `+`.
        assert_eq!(
            LinuxEnvManager::trace_path_fragments("export PATH=$HOME/.cargo/bin:$PATH"),
            vec!["$HOME/.cargo/bin"]
        );
        // Unrelated trace lines are ignored.
        assert!(LinuxEnvManager::trace_path_fragments("+ echo hello").is_empty());
    }

    #[test]
    fn bash_and_zsh_traces_are_attributed_to_the_declaring_file() {
        // bash: every `set -x` line starts with `+`, which the old parser sent
        // into the zsh branch and then dropped, so bash tracing produced nothing.
        let bash_trace = "\
+ . /home/dev/.bashrc
+ PATH=/usr/bin:/bin
+ PATH=/home/dev/.nvm/versions/node/v22/bin:/usr/bin:/bin
";
        let origins = LinuxEnvManager::parse_trace_origins(bash_trace);
        let nvm = origins
            .iter()
            .find(|(line, _)| line.contains("/home/dev/.nvm"))
            .expect("the prepended nvm folder must be attributed");
        assert!(
            !nvm.0.contains("/usr/bin"),
            "a re-assigned base folder is not a new origin: {}",
            nvm.0
        );
        assert_eq!(
            nvm.1,
            &(PathBuf::from("/home/dev/.bashrc"), 1),
            "the declaring script must be .bashrc"
        );

        // zsh: `+/path/file:12> export PATH=...`
        let zsh_trace = "+/home/dev/.zshrc:12> export PATH=/opt/tool/bin:$PATH\n";
        let origins = LinuxEnvManager::parse_trace_origins(zsh_trace);
        assert_eq!(
            origins.get("+ PATH=/opt/tool/bin"),
            Some(&(PathBuf::from("/home/dev/.zshrc"), 12))
        );

        // The shell's own initial PATH (before any script is sourced) is the
        // baseline too: it must not be re-credited to the first script that
        // re-assigns the whole value.
        let initial_then_script = "\
+ PATH=/usr/bin:/bin
+ . /home/dev/.bashrc
+ PATH=/usr/bin:/bin:/home/dev/extra/bin
";
        let origins = LinuxEnvManager::parse_trace_origins(initial_then_script);
        assert_eq!(origins.len(), 1, "only the added folder is recorded: {origins:?}");
        assert_eq!(
            origins.get("+ PATH=/home/dev/extra/bin"),
            Some(&(PathBuf::from("/home/dev/.bashrc"), 1))
        );
    }

    #[test]
    fn test_parse_dotfile_content() {
        let sample = r#"
# Sample .bashrc
export JAVA_HOME="/usr/lib/jvm/java-21-openjdk"
export PATH="$HOME/.cargo/bin:$PATH"
NODE_OPTIONS="--max-old-space-size=4096" # inline comment
set -gx GOPATH "$HOME/go"
"#;
        let parsed = LinuxEnvManager::parse_dotfile_content(sample);
        assert_eq!(parsed.len(), 4);
        assert_eq!(
            parsed[0],
            (
                "JAVA_HOME".to_string(),
                "/usr/lib/jvm/java-21-openjdk".to_string(),
                3
            )
        );
        assert_eq!(
            parsed[1],
            ("PATH".to_string(), "$HOME/.cargo/bin:$PATH".to_string(), 4)
        );
        assert_eq!(
            parsed[2],
            (
                "NODE_OPTIONS".to_string(),
                "--max-old-space-size=4096".to_string(),
                5
            )
        );
        assert_eq!(
            parsed[3],
            ("GOPATH".to_string(), "$HOME/go".to_string(), 6)
        );
    }

    #[test]
    fn quoted_values_round_trip_through_env_sh() {
        // `env.sh` is scanned again on the next launch. The parser must undo the
        // escaping the writer emits, or every Apply would shorten the value.
        let expandable = [
            r#"$(find "/etc/debuginfod" -name "*.urls" -print0)"#,
            "it's a value",
            r#"back\slash and "quotes" and it's"#,
        ];
        for value in expandable {
            let mut variable = var(value, true);
            variable.key = "ROUND_TRIP".to_string();
            let line = LinuxEnvManager::env_sh_variable_line(&variable);
            let parsed = LinuxEnvManager::parse_dotfile_content(&line);
            assert_eq!(parsed.len(), 1, "line: {line}");
            assert_eq!(
                parsed[0].1,
                LinuxEnvManager::as_shell_text(value),
                "line: {line}"
            );
        }

        let literal = "it's a $5 \\ path";
        let line = LinuxEnvManager::env_sh_variable_line(&var(literal, false));
        let parsed = LinuxEnvManager::parse_dotfile_content(&line);
        assert_eq!(parsed.len(), 1, "line: {line}");
        assert_eq!(parsed[0].1, literal, "line: {line}");
    }

    #[test]
    fn literal_values_keep_their_quoting_across_a_scan() {
        // A literal value is single-quoted in env.sh. The quote style, not the
        // presence of `$`, must decide whether the next Apply treats it as a
        // template — otherwise `pa$$` would be re-read as the shell PID.
        let original = var("pa$$ $5 \\", false);
        let line = LinuxEnvManager::env_sh_variable_line(&original);
        assert!(LinuxEnvManager::value_is_single_quoted(&line));

        let parsed = LinuxEnvManager::parse_dotfile_content(&line);
        assert_eq!(parsed.len(), 1);
        let reparsed = EnvVariable {
            key: "DEMO".to_string(),
            value: parsed[0].1.clone(),
            is_expandable: !LinuxEnvManager::value_is_single_quoted(&line)
                && (parsed[0].1.contains('$') || parsed[0].1.contains('~')),
            scope: Scope::Dotfile {
                file_path: PathBuf::from("/home/dev/.config/env-doctor/env.sh"),
                line_number: 1,
                expanded: true,
            },
            is_modified: false,
        };
        assert!(
            LinuxEnvManager::safe_variable_line(&reparsed).is_some(),
            "the saved literal must survive the next Apply"
        );
        assert_eq!(LinuxEnvManager::env_sh_variable_line(&reparsed), line);

        let expandable = var("$HOME/tools", true);
        assert!(!LinuxEnvManager::value_is_single_quoted(
            &LinuxEnvManager::env_sh_variable_line(&expandable)
        ));
    }

    #[test]
    fn a_single_quoted_value_in_any_config_stays_literal() {
        // The quoting in the user's own file states the intent, not just in
        // env.sh: `export TOKEN='pa$$word'` must not be written back as
        // `"pa$$word"`, which would expand `$$` to the process id.
        assert!(LinuxEnvManager::value_is_single_quoted(
            "export TOKEN='pa$$word'"
        ));
        assert!(LinuxEnvManager::value_is_single_quoted("TOKEN='pa$$word'"));
        assert!(LinuxEnvManager::value_is_single_quoted(
            "export TOKEN= 'pa$$word'"
        ));
        assert!(LinuxEnvManager::value_is_single_quoted(
            "set -gx TOKEN 'pa$$word'"
        ));
        assert!(LinuxEnvManager::value_is_single_quoted(
            "set -gx TOKEN 'pa$$ word'"
        ));

        // A template stays a template.
        assert!(!LinuxEnvManager::value_is_single_quoted(
            "export TOKEN=\"$HOME/word\""
        ));
        assert!(!LinuxEnvManager::value_is_single_quoted(
            "export TOKEN=$HOME/word"
        ));
        assert!(!LinuxEnvManager::value_is_single_quoted(
            "set -gx TOKEN \"$HOME/word\""
        ));
        assert!(!LinuxEnvManager::value_is_single_quoted(
            "set -gx TOKEN"
        ));
    }

    #[test]
    fn expansion_is_read_from_the_declaration_not_the_value_text() {
        // A value can contain `$` or `~` and still be literal: an escaped dollar
        // inside double quotes, a tilde inside quotes, or single quotes around
        // the whole value. Deciding from the text alone turned these into
        // templates on the next Apply and changed their value.
        for line in [
            "export A='$HOME/x'",
            r#"export A="\$HOME/x""#,
            r#"export A="~/bin""#,
            "export A=plain",
            "export A=",
            "set -gx A '$HOME'",
        ] {
            assert!(
                !LinuxEnvManager::value_uses_expansion(line),
                "{line} must stay literal"
            );
        }

        for line in [
            "export A=$HOME/x",
            r#"export A="$HOME/x""#,
            "export A=${HOME}/x",
            "export A=~/bin",
            "export A=`date`",
            r#"export A="$(date)""#,
            r#"set -gx A "$HOME""#,
            "set -gx A ~/bin",
        ] {
            assert!(
                LinuxEnvManager::value_uses_expansion(line),
                "{line} must still expand"
            );
        }
    }

    #[test]
    fn path_values_cannot_inject_shell_commands() {
        // The PATH line is double-quoted so `$HOME` keeps expanding, but an
        // imported or edited component must never be able to run a command in
        // every new shell, and a literal `$`/backtick/quote must survive.
        assert_eq!(
            LinuxEnvManager::shell_quote_path("/opt/a\"b\\c"),
            "\"/opt/a\\\"b\\\\c\""
        );
        assert_eq!(
            LinuxEnvManager::shell_quote_path("/opt/$(id)/bin"),
            "\"/opt/\\$(id)/bin\""
        );
        assert_eq!(
            LinuxEnvManager::shell_quote_path("/opt/`id`"),
            "\"/opt/\\`id\\`\""
        );
        assert_eq!(
            LinuxEnvManager::shell_quote_path("$HOME/bin"),
            "\"$HOME/bin\""
        );
        assert_eq!(
            LinuxEnvManager::shell_quote_path("${HOME}/bin"),
            "\"${HOME}/bin\""
        );
        // `$HOMEDIR` is a different variable, not the portable home form.
        assert_eq!(
            LinuxEnvManager::shell_quote_path("$HOMEDIR/bin"),
            "\"\\$HOMEDIR/bin\""
        );
    }

    fn entry(scope: Scope, exists: bool) -> PathEntry {
        // The persistence check re-stats a Process entry, so a "live" fixture
        // must point at a real directory and a dead one at a missing path.
        let dir = if exists {
            std::env::temp_dir()
        } else {
            std::env::temp_dir().join(format!("env-doctor-missing-{}", Uuid::new_v4()))
        };
        PathEntry {
            id: "1".into(),
            raw_value: dir.to_string_lossy().to_string(),
            resolved_value: dir,
            scope,
            source_text: None,
            exists,
            executable_count: 0,
            issues: vec![],
        }
    }

    #[test]
    fn dead_session_entries_are_not_persisted() {
        // An `npm`-injected ancestor folder that does not exist must never be
        // written into the saved configuration...
        assert!(!LinuxEnvManager::should_persist_path_entry(&entry(
            Scope::Process,
            false
        )));
        // ...while a live session folder is kept: this is how nvm puts `node` on
        // the PATH, so dropping it would break the user's toolchain.
        assert!(LinuxEnvManager::should_persist_path_entry(&entry(
            Scope::Process,
            true
        )));
        // Entries the user declared are always written back.
        let dotfile = Scope::Dotfile {
            file_path: PathBuf::from("/home/dev/.bashrc"),
            line_number: 12,
            expanded: true,
        };
        assert!(LinuxEnvManager::should_persist_path_entry(&entry(
            dotfile, false
        )));
    }

    #[test]
    fn live_project_session_entries_are_not_persisted() {
        // A folder inside one project (`node_modules/.bin`) exists right now, but
        // freezing it into the permanent PATH would break as soon as the project
        // moves or is deleted.
        for project_path in [
            "/home/dev/work/myapp/node_modules/.bin",
            "/home/dev/work/api/.venv/bin",
            "/home/dev/work/api/venv/bin",
            "/home/dev/work/api/__pypackages__/3.12/bin",
        ] {
            let project = PathEntry {
                resolved_value: PathBuf::from(project_path),
                ..entry(Scope::Process, true)
            };
            assert!(
                LinuxEnvManager::is_build_injected_dir(Path::new(project_path)),
                "{project_path} must be recognized as build-injected"
            );
            assert!(
                !LinuxEnvManager::should_persist_path_entry(&project),
                "{project_path} must not be persisted"
            );
        }

        // npm also injects its own `node-gyp-bin` (inside the npm install, not
        // inside the user's project) for the duration of a lifecycle script.
        // Persisting it would pin a path that changes with every npm upgrade.
        let node_gyp_bin_path = "/home/dev/.nvm/versions/node/v24.22.0/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin";
        assert!(LinuxEnvManager::is_build_injected_dir(Path::new(
            node_gyp_bin_path
        )));
        let node_gyp_bin = PathEntry {
            resolved_value: PathBuf::from(node_gyp_bin_path),
            ..entry(Scope::Process, true)
        };
        assert!(!LinuxEnvManager::should_persist_path_entry(&node_gyp_bin));

        // Tool-manager folders are not project-local and stay when they exist.
        let base = std::env::temp_dir().join(format!("envdoc_session_{}", Uuid::new_v4()));
        let node_bin = base.join("versions/node/v24.22.0/bin");
        fs::create_dir_all(&node_bin).unwrap();
        let nvm = PathEntry {
            resolved_value: node_bin,
            ..entry(Scope::Process, true)
        };
        assert!(LinuxEnvManager::should_persist_path_entry(&nvm));

        // A user-declared project folder is still the user's own choice.
        let declared = PathEntry {
            resolved_value: PathBuf::from("/home/dev/work/myapp/node_modules/.bin"),
            ..entry(
                Scope::Dotfile {
                    file_path: PathBuf::from("/home/dev/.bashrc"),
                    line_number: 3,
                    expanded: true,
                },
                true,
            )
        };
        assert!(LinuxEnvManager::should_persist_path_entry(&declared));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn shell_locals_are_not_reported_as_environment_variables() {
        // `/etc/profile.d` scripts are programs: `prefix`, `key` and `bad_kv` are
        // locals that never reach the environment, so they must not inflate the
        // variable count. Values that the file *does* export must survive.
        let script = r#"
prefix="/usr"
key=${w1%%=*}
bad_kv="${bad_kv} $bad=$val"
DEBUGINFOD_URLS=$(find /etc/debuginfod -name '*.urls')
[ -n "$DEBUGINFOD_URLS" ] && export DEBUGINFOD_URLS || unset DEBUGINFOD_URLS
XDG_CONFIG_DIRS="$DEFAULT_XDG_CONFIG_DIRS"
export XDG_CONFIG_DIRS
set -gx GOPATH "$HOME/go"
"#;
        let keys: Vec<String> = LinuxEnvManager::extract_environment_declarations(
            Path::new("/etc/profile.d/example.sh"),
            script,
        )
        .into_iter()
        .map(|(key, _, _)| key)
        .collect();

        assert!(keys.contains(&"DEBUGINFOD_URLS".to_string()), "{keys:?}");
        assert!(keys.contains(&"XDG_CONFIG_DIRS".to_string()), "{keys:?}");
        assert!(keys.contains(&"GOPATH".to_string()), "{keys:?}");
        assert!(!keys.contains(&"prefix".to_string()), "{keys:?}");
        assert!(!keys.contains(&"key".to_string()), "{keys:?}");
        assert!(!keys.contains(&"bad_kv".to_string()), "{keys:?}");
    }

    #[test]
    fn bare_path_assignment_in_a_shell_file_is_a_declaration() {
        // `PATH` is already exported by the login environment, so the stock
        // Debian/Ubuntu `~/.profile` block `PATH="$HOME/.local/bin:$PATH"` (no
        // `export`) really does change the environment. It must be attributed to
        // that file instead of becoming a session entry.
        let content = "\
if [ -d \"$HOME/.local/bin\" ]; then
    PATH=\"$HOME/.local/bin:$PATH\"
fi
";
        let parsed = LinuxEnvManager::extract_environment_declarations(
            Path::new("/home/dev/.profile"),
            content,
        );
        assert!(
            parsed
                .iter()
                .any(|(key, value, line)| key == "PATH" && value.contains(".local/bin") && *line == 2),
            "the bare PATH assignment must be recorded: {parsed:?}"
        );
    }

    #[test]
    fn environment_style_files_keep_bare_assignments() {
        // `environment.d` and `/etc/environment` list assignments directly, so a
        // bare `KEY=value` there is a real environment variable, not a local.
        for path in [
            "/etc/environment",
            "/etc/environment.d/90qt-a11y.conf",
            "/usr/lib/environment.d/990-snapd.conf",
            "/home/dev/.config/environment.d/50-user.conf",
            "/home/dev/.pam_environment",
        ] {
            assert!(
                LinuxEnvManager::is_environment_style_file(Path::new(path)),
                "{path} must be treated as an environment file"
            );
        }
        for path in [
            "/etc/profile",
            "/etc/profile.d/example.sh",
            "/home/dev/.bashrc",
            "/home/dev/.cargo/env",
            "/home/dev/.config/env-doctor/env.sh",
        ] {
            assert!(
                !LinuxEnvManager::is_environment_style_file(Path::new(path)),
                "{path} must be treated as a shell script"
            );
        }

        let keys: Vec<String> = LinuxEnvManager::extract_environment_declarations(
            Path::new("/etc/environment.d/90qt-a11y.conf"),
            "QT_ACCESSIBILITY=1\nPATH=$PATH:/snap/bin\n",
        )
        .into_iter()
        .map(|(key, _, _)| key)
        .collect();
        assert!(keys.contains(&"QT_ACCESSIBILITY".to_string()), "{keys:?}");
        assert!(keys.contains(&"PATH".to_string()), "{keys:?}");
    }

    #[test]
    fn pam_environment_uses_space_separated_default_syntax() {
        // pam_env files are not shell scripts: a line is `KEY [DEFAULT=]value`,
        // so the ordinary `KEY=value` parser saw no declarations in them.
        let parsed = LinuxEnvManager::extract_environment_declarations(
            Path::new("/home/dev/.pam_environment"),
            "# managed by hand\nPATH DEFAULT=${PATH}:~/bin\nLANG DEFAULT=en_US.UTF-8\n",
        );
        assert_eq!(
            parsed,
            vec![
                ("PATH".to_string(), "${PATH}:~/bin".to_string(), 2),
                ("LANG".to_string(), "en_US.UTF-8".to_string(), 3),
            ]
        );
    }

    #[test]
    fn distro_name_is_reported_when_available() {
        // Falls back to "<os> (Linux)" only when /etc/os-release is unreadable.
        let name = LinuxEnvManager::distro_name();
        assert!(!name.is_empty());
        if std::path::Path::new("/etc/os-release").exists() {
            assert_ne!(name, "Linux", "the distro name must come from /etc/os-release");
        }
    }
}
