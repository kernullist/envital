import { version as appVersion } from "../../package.json";
import {
  formatScopeInfo,
  isSessionScope,
  isUnscoredIssue,
  type BinaryConflict,
  type DiagnosticReport,
  type PathEntry,
  type Scope,
} from "../types/ipc";
import { describeIssue } from "./diagnosticMessages";

export type ReportFormat = "markdown" | "json" | "csv";

export interface ReportFormatMeta {
  id: ReportFormat;
  label: string;
  description: string;
  extension: string;
  filterName: string;
  mimeType: string;
}

/** Offered in the export menu, in this order. */
export const REPORT_FORMATS: ReportFormatMeta[] = [
  {
    id: "markdown",
    label: "Markdown report",
    description: "Readable summary to paste into a chat or issue.",
    extension: "md",
    filterName: "Markdown",
    mimeType: "text/markdown",
  },
  {
    id: "json",
    label: "JSON report",
    description: "Full structured data for scripts.",
    extension: "json",
    filterName: "JSON",
    mimeType: "application/json",
  },
  {
    id: "csv",
    label: "CSV table",
    description: "One row per PATH entry, for spreadsheets.",
    extension: "csv",
    filterName: "CSV",
    mimeType: "text/csv",
  },
];

export const TOOL_NAME = "Env & PATH Doctor";

/**
 * Environment variable **values are never exported**. A PATH diagnostic report
 * is something users paste into public issue trackers, and variables routinely
 * hold API keys and tokens. Only the count is reported.
 */
const SECRETS_NOTE =
  "Environment variable values are intentionally omitted from this report.";

/**
 * Variables that belong to the user's configuration.
 *
 * `report.variables` also contains every variable of the *running process*
 * (`CARGO_*`, shell internals, editor variables). Those are not configuration,
 * cannot be restored from a report and would drown the handful of real
 * settings, so they are not counted — the Variables tab excludes them too.
 */
function configuredVariableCount(report: DiagnosticReport): number {
  return report.variables.filter((variable) => variable.scope !== "Process")
    .length;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local-time timestamp, e.g. `2026-10-19 16:45:12`. */
export function localTimestamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Filename-safe timestamp, e.g. `2026-10-19-164512`. */
export function fileTimestamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function scopeLabel(scope: Scope): string {
  const info = formatScopeInfo(scope);
  switch (info.kind) {
    case "user":
      return "User";
    case "system":
      return "System";
    case "process":
      return "Session";
    default:
      return "Config file";
  }
}

/**
 * Name the file an entry was declared in. This is the field that answers "where do
 * I go to fix this?", so the report always states it instead of guessing from the
 * folder alone.
 */
function declaredIn(entry: PathEntry): string {
  if (typeof entry.scope === "object" && entry.scope !== null && "Dotfile" in entry.scope) {
    const { file_path, line_number } = entry.scope.Dotfile;
    return `${file_path} (line ${line_number})`;
  }
  if (entry.scope === "Process") {
    return "not declared in any config file (session)";
  }
  // A User/System entry without source text is not an "app setting": on Windows
  // it comes from the registry hive named by `formatScopeInfo`, which is where
  // the reader has to go to change it.
  return entry.source_text ?? formatScopeInfo(entry.scope).sourceText;
}

/** Whether an issue is something the user should fix, a tip, or purely a note. */
function attentionLabel(entry: PathEntry): string {
  // The on-screen Doctor view sorts entries by the same rule: anything that is
  // scored (`!isUnscoredIssue`) is a problem, `OrderRisk` is an optional tip and
  // `AliasPath` is a note. Deriving the label from severity would call a scored
  // hard-coded home path a "hardening tip", contradicting the screen and the
  // summary count in this same report.
  if (entry.issues.some((issue) => !isUnscoredIssue(issue))) return "needs attention";
  if (entry.issues.some((issue) => typeof issue === "object" && issue !== null && "OrderRisk" in issue)) {
    return "hardening tip";
  }
  return "no action needed";
}

function csvCell(value: string | number | boolean): string {
  let text = String(value);
  // A cell beginning with a formula character is executed when the export is
  // opened in a spreadsheet. PATH entries and variable names come from the
  // machine (or from an imported file), so a hostile value must not become a
  // formula; a leading apostrophe is the spreadsheet's text marker.
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Extra context about the scan the report was taken from. */
export interface ReportContext {
  /** Timestamp shown in the report; defaults to now. */
  generatedAt?: string;
  /** Edits staged in the UI but not yet applied to the real environment. */
  stagedChangeCount?: number;
}

/** Render the current diagnostic state in the requested format. */
export function renderDiagnosticReport(
  format: ReportFormat,
  report: DiagnosticReport,
  context: ReportContext = {}
): string {
  const generatedAt = context.generatedAt ?? localTimestamp();
  switch (format) {
    case "json":
      return renderJson(report, generatedAt, context);
    case "csv":
      return renderCsv(report);
    default:
      return renderMarkdown(report, generatedAt, context);
  }
}

function renderJson(
  report: DiagnosticReport,
  generatedAt: string,
  context: ReportContext
): string {
  const entries = report.path_entries;
  return JSON.stringify(
    {
      tool: TOOL_NAME,
      app_version: appVersion,
      generated_at: generatedAt,
      health_score: report.score,
      os_context: report.os_context,
      summary: {
        path_entries: entries.length,
        dead_paths: report.dead_count,
        duplicate_entries: report.duplicate_count,
        symlink_aliases: report.alias_count,
        empty_directories: report.empty_count,
        unexpanded_home_paths: report.unexpanded_count,
        world_writable_folders: report.security_count,
        user_folders_before_system_paths: report.order_count,
        session_path_entries: report.session_count,
        binary_conflicts: report.conflict_count,
        environment_variables: configuredVariableCount(report),
        staged_changes: context.stagedChangeCount ?? 0,
      },
      path_entries: entries,
      conflicts: report.conflicts,
      notes: [SECRETS_NOTE],
    },
    null,
    2
  );
}

function renderMarkdown(
  report: DiagnosticReport,
  generatedAt: string,
  context: ReportContext
): string {
  const entries: PathEntry[] = report.path_entries;
  const lines: string[] = [];
  const push = (...rows: string[]) => lines.push(...rows);

  push(`# ${TOOL_NAME} — Diagnostic Report`, "");
  push("| | |", "| :--- | :--- |");
  push(`| Generated | ${generatedAt} |`);
  push(`| App version | ${appVersion} |`);
  push(`| Host | ${report.os_context.os_name} (${report.os_context.arch}) |`);
  push(`| Shell | ${report.os_context.shell} |`);
  push(`| Home folder | \`${report.os_context.home_dir}\` |`);
  push(`| Elevated | ${report.os_context.is_elevated ? "yes" : "no"} |`);
  push(
    `| PATH length | ${report.os_context.total_path_length} / ` +
      `${report.os_context.max_path_length} characters |`
  );
  push(`| **Health score** | **${report.score} / 100** |`);
  push("");

  push("## Summary", "");
  push("| Category | Count |", "| :--- | ---: |");
  push(`| PATH entries scanned | ${entries.length} |`);
  push(`| … of which session/runtime entries (not in any config file) | ${report.session_count} |`);
  push(`| Missing folders (dead paths) | ${report.dead_count} |`);
  push(`| Duplicate entries | ${report.duplicate_count} |`);
  push(`| Symlink aliases (no action needed) | ${report.alias_count} |`);
  push(`| Folders with no programs | ${report.empty_count} |`);
  push(`| Hard-coded home paths | ${report.unexpanded_count} |`);
  push(`| World-writable folders | ${report.security_count} |`);
  push(`| User folders searched before the system folders (hardening tip, no score effect) | ${report.order_count} |`);
  push(`| Binary shadowing conflicts | ${report.conflict_count} |`);
  push(`| Environment variables (from config files) | ${configuredVariableCount(report)} |`);
  push("");

  if (report.session_count > 0) {
    push(
      `> ${report.session_count} of the ${entries.length} entries are **session ` +
        `entries**: the running process contributed them (a tool manager or ` +
        `package manager prepended a folder). No config file declares them, so ` +
        `they are listed separately below and are excluded from every count ` +
        `above and from the health score.`,
      ""
    );
  }

  if ((context.stagedChangeCount ?? 0) > 0) {
    push(
      `> **Preview only:** this report includes ` +
        `${context.stagedChangeCount} staged change(s) that have not been ` +
        `applied to the real environment yet.`,
      ""
    );
  }

  const findings = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.issues.length > 0);

  push("## Findings", "");
  if (findings.length === 0) {
    push("No problems found: every PATH entry is reachable and in a safe order.", "");
  }

  findings.forEach(({ entry, index }, position) => {
    push(
      `### ${position + 1}. \`${entry.raw_value}\` — ${attentionLabel(entry)}`,
      ""
    );
    push(`- Position: #${index + 1} (${scopeLabel(entry.scope)})`);
    push(`- Declared in: ${declaredIn(entry)}`);
    push(`- Resolves to: \`${entry.resolved_value}\``);
    push(`- Executables found: ${entry.executable_count}`);
    push("");

    for (const issue of entry.issues) {
      const detail = describeIssue(issue, entries);
      push(`**${detail.code} — ${detail.title}**`, "");
      push(`> ${detail.what}`);
      if (detail.why) {
        push(`>`, `> ${detail.why}`);
      }
      push("");
      if (detail.actionLabel) {
        push(`Suggested fix: ${detail.actionLabel}`, "");
      }
    }
  });

  const sessionEntries = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isSessionScope(entry.scope));

  if (sessionEntries.length > 0) {
    push("## Session PATH entries (not in any config file)", "");
    push(
      "These entries exist only because of the process that started the app — a " +
        "tool manager or package manager prepended them. Nothing here is a " +
        "problem you can fix by editing a file, so they are never scored and " +
        "never flagged. They are listed so the effective PATH is complete.",
      ""
    );
    push("| Position | Path | Exists | Executables |", "| ---: | :--- | :---: | ---: |");
    for (const { entry, index } of sessionEntries) {
      push(
        `| #${index + 1} | \`${entry.raw_value}\` | ${
          entry.exists ? "yes" : "no"
        } | ${entry.executable_count} |`
      );
    }
    push("");
  }

  if (report.conflicts.length > 0) {
    push("## Binary shadowing conflicts", "");
    push(
      `These ${report.conflicts.length} command(s) exist in more than one PATH ` +
        "folder. The first match wins, so the other copies are unreachable.",
      ""
    );
    for (const conflict of report.conflicts) {
      push(...renderConflictMarkdown(conflict), "");
    }
  }

  push("---", "");
  push(`${SECRETS_NOTE}`, "");
  push(`Generated by ${TOOL_NAME} ${appVersion}.`);

  return lines.join("\n");
}

function renderConflictMarkdown(conflict: BinaryConflict): string[] {
  const rows = [
    `### \`${conflict.binary_name}\` — ${conflict.locations.length} copies`,
    "",
    "| Active | Position | Path | Version |",
    "| :---: | :--- | :--- | :--- |",
  ];
  for (const location of conflict.locations) {
    rows.push(
      `| ${location.is_active ? "yes" : ""} | #${location.path_entry_index + 1} | ` +
        `\`${location.full_path}\` | ${location.version_hint ?? ""} |`
    );
  }
  return rows;
}

function renderCsv(report: DiagnosticReport): string {
  const header = [
    "position",
    "scope",
    "kind",
    "declared_in",
    "raw_value",
    "resolved_value",
    "exists",
    "executable_count",
    "issue_count",
    "issues",
    "issue_details",
  ];

  const rows = report.path_entries.map((entry, index) => {
    const details = entry.issues.map((issue) => describeIssue(issue, report.path_entries));
    return [
      index + 1,
      scopeLabel(entry.scope),
      isSessionScope(entry.scope) ? "session" : "configured",
      declaredIn(entry),
      entry.raw_value,
      entry.resolved_value,
      entry.exists ? "yes" : "no",
      entry.executable_count,
      entry.issues.length,
      details.map((detail) => detail.code).join(" | "),
      details.map((detail) => detail.what).join(" | "),
    ];
  });

  // A BOM keeps Excel from mis-reading UTF-8 path names.
  const body = [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  return `\uFEFF${body}\r\n`;
}
