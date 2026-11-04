import React from "react";
import {
  AlertTriangle,
  ArrowUp,
  FolderX,
  GitMerge,
  Info,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import type { DiagnosticIssue, PathEntry } from "../../types/ipc";
import { describeIssue, SEVERITY_STYLE } from "../../utils/diagnosticMessages";

interface Props {
  issue: DiagnosticIssue;
  entry: PathEntry;
  /** Full PATH list, used to show the real path behind "position #N" references. */
  allEntries: PathEntry[];
  /** `inline` puts the fix button on the right, `stacked` puts it full width below. */
  layout?: "inline" | "stacked";
  /** Compact styling for the dense PATH editor list. */
  dense?: boolean;
  /** Safe-Guard: critical system paths cannot be removed. */
  isProtected?: boolean;
}

function iconFor(code: string) {
  switch (code) {
    case "DEAD_PATH":
      return <FolderX className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
    case "EMPTY_DIR":
      return <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
    case "DUPLICATE":
      return <GitMerge className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
    case "UNEXPANDED":
      return <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
    case "PERMISSION_WARN":
      return <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
    case "PATH_ORDER":
      return <ArrowUp className="w-3.5 h-3.5 shrink-0 mt-0.5 rotate-180" />;
    default:
      return <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
  }
}

/**
 * Renders one diagnostic finding together with the concrete fix for it.
 *
 * All wording comes from `describeIssue` so the Doctor view, the PATH editor and
 * the right inspector can never drift apart, and every message names the exact
 * path/position it refers to.
 */
export const DiagnosticIssueCard: React.FC<Props> = ({
  issue,
  entry,
  allEntries,
  layout = "inline",
  dense = false,
  isProtected = false,
}) => {
  const {
    removePathEntry,
    mergeDuplicateEntry,
    shortenUnexpandedEntry,
    moveRiskyPathAfterSystem,
  } = useEnvStore();

  const detail = describeIssue(issue, allEntries);
  const style = SEVERITY_STYLE[detail.severity];

  const action = (() => {
    switch (detail.code) {
      case "DEAD_PATH":
      case "EMPTY_DIR":
        return {
          label: detail.actionLabel ?? "Remove",
          icon: <Trash2 className="w-3 h-3" />,
          disabled: isProtected,
          run: () => removePathEntry(entry.id),
        };
      case "DUPLICATE":
        return {
          label: detail.actionLabel ?? "Merge",
          icon: <GitMerge className="w-3 h-3" />,
          disabled: false,
          run: () => mergeDuplicateEntry(entry.id),
        };
      case "UNEXPANDED": {
        const suggested =
          typeof issue === "object" && "UnexpandedVariable" in issue
            ? issue.UnexpandedVariable.suggested
            : null;
        if (!suggested) return null;
        return {
          label: detail.actionLabel ?? "Shorten",
          icon: <Sparkles className="w-3 h-3" />,
          disabled: false,
          run: () => shortenUnexpandedEntry(entry.id, suggested),
        };
      }
      case "PERMISSION_WARN":
        return {
          label: detail.actionLabel ?? "Remove",
          icon: <Trash2 className="w-3 h-3" />,
          disabled: isProtected,
          run: () => removePathEntry(entry.id),
        };
      case "PATH_ORDER":
        return {
          label: detail.actionLabel ?? "Move down",
          icon: <ArrowUp className="w-3 h-3 rotate-180" />,
          disabled: false,
          run: () => moveRiskyPathAfterSystem(entry.id),
        };
      default:
        return null;
    }
  })();

  const button = action ? (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!action.disabled) action.run();
      }}
      disabled={action.disabled}
      title={
        action.disabled
          ? "Protected by Safe Guard — this critical system path cannot be removed"
          : detail.actionLabel
      }
      className={`${style.button} text-[11px] font-semibold flex items-center gap-1 shrink-0 transition rounded disabled:opacity-40 disabled:cursor-not-allowed ${
        layout === "stacked" ? "w-full justify-center py-1 px-2" : "px-2 py-0.5"
      }`}
    >
      {action.icon} {action.label}
    </button>
  ) : null;

  if (dense) {
    return (
      <div
        className={`flex items-center justify-between gap-2 text-[11px] border rounded-md px-2.5 py-1 ${style.row}`}
      >
        <div className="min-w-0">
          <div className={`${style.title} font-medium`}>
            <span className="opacity-70">└─ </span>
            <span className="font-semibold">{detail.title}</span>
            {detail.what && (
              <span className="font-normal"> — {detail.what}</span>
            )}
          </div>
          {detail.why && (
            <div className={`${style.muted} mt-0.5`}>{detail.why}</div>
          )}
        </div>
        {button}
      </div>
    );
  }

  return (
    <div
      className={`border rounded-lg px-3 py-2 text-xs ${style.row} ${
        layout === "stacked" ? "space-y-2" : "flex items-start justify-between gap-3"
      }`}
    >
      <div className="min-w-0 space-y-0.5">
        <div className={`flex items-start gap-2 font-semibold ${style.title}`}>
          {iconFor(detail.code)}
          <span>
            <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-slate-950/40 mr-1.5 align-middle">
              {detail.code}
            </span>
            {detail.title}
          </span>
        </div>
        {detail.what && (
          <div className={`text-[11px] pl-5 ${style.title} opacity-90`}>
            {detail.what}
          </div>
        )}
        {detail.why && (
          <div className={`text-[11px] pl-5 ${style.muted}`}>
            {detail.why}
          </div>
        )}
      </div>
      {layout === "inline" && button}
      {layout === "stacked" && button}
    </div>
  );
};
