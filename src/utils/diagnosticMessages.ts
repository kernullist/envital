import type { DiagnosticIssue, PathEntry } from "../types/ipc";

/**
 * Single source of truth for every diagnostic message shown in the UI.
 *
 * Each entry answers three questions the user actually asks:
 *   1. `title`  — what kind of problem is this? (short, plain language)
 *   2. `what`   — what exactly did we find? (names the concrete path / position)
 *   3. `why`    — why does it matter, and what happens if I ignore it?
 *
 * `actionLabel` names the concrete fix. Informational findings set
 * `informational: true` so the UI can keep them out of the problem list.
 */
export type IssueSeverity = "error" | "warning" | "tip" | "security" | "info";

export interface IssueExplanation {
  /** Diagnostic code, e.g. `DUPLICATE`. */
  code: string;
  severity: IssueSeverity;
  title: string;
  what: string;
  why: string;
  actionLabel?: string;
  /** Nothing is wrong — this is a note, not a problem. */
  informational: boolean;
}

/** Resolve a PATH entry index to the text the user sees in the list. */
function entryLabel(entries: PathEntry[], index: number): string | null {
  const found = entries[index];
  if (!found) return null;
  return found.raw_value || found.resolved_value || null;
}

/** Name the file an entry was declared in, so a reader can go and edit it. */
function sourceLabel(entry: PathEntry | undefined): string | null {
  if (!entry) return null;
  if (entry.scope === "Process") return "the current session (no config file declares it)";
  if (typeof entry.scope === "object" && entry.scope !== null && "Dotfile" in entry.scope) {
    const { file_path, line_number } = entry.scope.Dotfile;
    return `${file_path} (line ${line_number})`;
  }
  return entry.source_text ?? null;
}

export function describeIssue(
  issue: DiagnosticIssue,
  entries: PathEntry[] = []
): IssueExplanation {
  if (issue === "DeadPath") {
    return {
      code: "DEAD_PATH",
      severity: "error",
      informational: false,
      title: "This folder does not exist",
      what: "The path is still listed in PATH, but there is no such directory on disk.",
      why: "Every command you run makes the shell check each PATH folder in order. A missing folder can never hold a program, so it only adds a failed lookup and slows commands down.",
      actionLabel: "Remove from PATH",
    };
  }

  if (issue === "EmptyDirectory") {
    return {
      code: "EMPTY_DIR",
      severity: "warning",
      informational: false,
      title: "This folder has no programs in it",
      what: "The directory exists, but it contains no runnable files.",
      why: "An empty folder can never resolve a command, so it contributes nothing and adds one more lookup to every command you run.",
      actionLabel: "Remove from PATH",
    };
  }

  if (typeof issue === "object" && "Duplicate" in issue) {
    const first = issue.Duplicate.first_seen_index;
    const label = entryLabel(entries, first);
    const firstSource = sourceLabel(entries[first]);
    const where = firstSource ? `, declared in ${firstSource}` : "";
    return {
      code: "DUPLICATE",
      severity: "warning",
      informational: false,
      title: "The same path is listed twice",
      what: label
        ? `"${label}" already appears at position #${first + 1}${where}.`
        : `The identical path already appears at position #${first + 1}${where}.`,
      why: "The shell stops at the first match, so this second copy is never reached. Removing it does not change which programs run.",
      actionLabel: "Merge — remove this copy",
    };
  }

  if (typeof issue === "object" && "AliasPath" in issue) {
    const first = issue.AliasPath.first_seen_index;
    const label = entryLabel(entries, first);
    const canonical = issue.AliasPath.canonical;
    let what: string;
    if (!label) {
      what = `This entry resolves to ${canonical}, the same folder already covered at position #${first + 1}.`;
    } else if (label === canonical) {
      what = `"${label}" at position #${first + 1} is the same physical folder as this entry — this path is just a symlink to it.`;
    } else {
      what = `"${label}" at position #${first + 1} is the same physical folder as this entry: both resolve to ${canonical}.`;
    }
    return {
      code: "ALIAS_PATH",
      severity: "info",
      informational: true,
      title: "No fix needed — two names for the same folder",
      what,
      why: "On most Linux distributions /bin and /sbin are symlinks to /usr/bin and /usr/sbin. Keeping both is harmless and matches your distribution default, so this entry is deliberately left alone.",
    };
  }

  if (typeof issue === "object" && "UnexpandedVariable" in issue) {
    return {
      code: "UNEXPANDED",
      severity: "tip",
      informational: false,
      title: "Your home folder is hard-coded",
      what: `This entry spells out your home folder literally instead of using a variable. It can be rewritten as ${issue.UnexpandedVariable.suggested}.`,
      why: "A hard-coded home path breaks silently if the home folder is renamed, moved, or the settings are copied to another machine. A variable keeps working.",
      actionLabel: "Rewrite using the variable",
    };
  }

  if (typeof issue === "object" && "SecurityRisk" in issue) {
    return {
      code: "PERMISSION_WARN",
      severity: "security",
      informational: false,
      title: "Every user on this machine can put programs here",
      what: issue.SecurityRisk.reason,
      why: "The folder is world-writable and the shell searches it, so another account could drop a program here that runs instead of the real command.",
      actionLabel: "Remove from PATH",
    };
  }

  if (typeof issue === "object" && "OrderRisk" in issue) {
    return {
      code: "PATH_ORDER",
      severity: "tip",
      informational: false,
      title: "A folder you can write to comes before the system folders",
      what: issue.OrderRisk.reason,
      why: "This is the normal setup for rustup, nvm and similar tool managers, so it is a hardening note rather than a fault — it costs no health score. Reorder it only if you run code you do not trust on this machine.",
      actionLabel: "Move below the system folders",
    };
  }

  return {
    code: "UNKNOWN",
    severity: "info",
    informational: true,
    title: "Diagnostic note",
    what: String(issue),
    why: "",
  };
}

/** Shared Tailwind colour tokens per severity so all views look consistent. */
export const SEVERITY_STYLE: Record<
  IssueSeverity,
  { row: string; title: string; muted: string; button: string; chip: string }
> = {
  error: {
    row: "bg-rose-500/10 border-rose-500/25",
    title: "text-rose-300",
    muted: "text-rose-200/70",
    button: "bg-rose-500/20 hover:bg-rose-500/30 text-rose-100",
    chip: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  },
  security: {
    row: "bg-rose-500/15 border-rose-500/30",
    title: "text-rose-200",
    muted: "text-rose-200/70",
    button: "bg-rose-500/25 hover:bg-rose-500/35 text-rose-50",
    chip: "bg-rose-500/20 text-rose-200 border-rose-500/40",
  },
  warning: {
    row: "bg-amber-500/10 border-amber-500/25",
    title: "text-amber-300",
    muted: "text-amber-200/70",
    button: "bg-amber-500/20 hover:bg-amber-500/30 text-amber-100",
    chip: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  tip: {
    row: "bg-sky-500/10 border-sky-500/25",
    title: "text-sky-300",
    muted: "text-sky-200/70",
    button: "bg-sky-500/20 hover:bg-sky-500/30 text-sky-100",
    chip: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  },
  info: {
    row: "bg-slate-500/10 border-slate-500/25",
    title: "text-slate-200",
    muted: "text-slate-400",
    button: "",
    chip: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  },
};
