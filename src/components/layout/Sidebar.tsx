import React from "react";
import {
  Activity,
  FolderKanban,
  History,
  Laptop,
  ListOrdered,
  Package,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import type { NavTab } from "../../types/ipc";

export const Sidebar: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    score,
    pathEntries,
    conflictCount,
    variables,
    snapshots,
    profiles,
    osContext,
    deadCount,
    duplicateCount,
    emptyCount,
    unexpandedCount,
    securityCount,
  } = useEnvStore();

  // Actionable, scored problems only. Aliases/order tips are informational and
  // session entries are excluded on purpose, so they must not light up the badge.
  const totalIssues =
    deadCount + duplicateCount + emptyCount + unexpandedCount + securityCount;
  const lengthRatio = Math.min(
    100,
    Math.round(
      (osContext.total_path_length / Math.max(1, osContext.max_path_length)) *
        100
    )
  );

  const navItems: {
    group: string;
    items: {
      id: NavTab;
      label: string;
      icon: React.ReactNode;
      badge?: string | number;
      badgeColor?: string;
    }[];
  }[] = [
    {
      group: "Diagnostics & Control",
      items: [
        {
          id: "doctor",
          label: "🩺 Health Check",
          icon: <Activity className="w-4 h-4" />,
          badge: `${score} pts`,
          badgeColor:
            score >= 85
              ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
              : score >= 65
                ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                : "bg-rose-500/15 text-rose-400 border-rose-500/30",
        },
        {
          id: "path-editor",
          label: "🛤️ PATH Editor",
          icon: <ListOrdered className="w-4 h-4" />,
          badge: totalIssues > 0 ? `! ${totalIssues}` : pathEntries.length,
          badgeColor:
            totalIssues > 0
              ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
              : "bg-slate-800 text-slate-300 border-slate-700",
        },
        {
          id: "shadowing",
          label: "⚡ Binary Conflicts",
          icon: <Zap className="w-4 h-4" />,
          badge: conflictCount,
          badgeColor:
            conflictCount > 0
              ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
              : "bg-slate-800 text-slate-400 border-slate-700",
        },
        {
          id: "variables",
          label: "📦 Variables",
          icon: <Package className="w-4 h-4" />,
          badge: variables.filter((v) => v.scope !== "Process").length,
          badgeColor: "bg-slate-800 text-slate-300 border-slate-700",
        },
      ],
    },
    {
      group: "Safeguards",
      items: [
        {
          id: "timemachine",
          label: "🕒 Time Machine",
          icon: <History className="w-4 h-4" />,
          badge: snapshots.length || undefined,
          badgeColor: "bg-sky-500/15 text-sky-400 border-sky-500/30",
        },
        {
          id: "profiles",
          label: "🗂️ Profiles",
          icon: <FolderKanban className="w-4 h-4" />,
          badge: profiles.length || undefined,
          badgeColor: "bg-violet-500/15 text-violet-400 border-violet-500/30",
        },
      ],
    },
  ];

  return (
    <aside className="w-60 border-r border-slate-800/80 bg-slate-900/60 flex flex-col justify-between shrink-0 select-none">
      {/* Navigation Groups */}
      <div className="p-3 space-y-5 overflow-y-auto">
        {navItems.map((section) => (
          <div key={section.group}>
            <div className="px-2.5 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              [{section.group}]
            </div>
            <div className="space-y-1">
              {section.items.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium transition-all ${
                      isActive
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm"
                        : "text-slate-300 hover:bg-slate-800/70 hover:text-slate-100 border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          isActive ? "text-emerald-400" : "text-slate-400"
                        }
                      >
                        {item.icon}
                      </span>
                      <span>{item.label}</span>
                    </div>
                    {item.badge !== undefined && (
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${item.badgeColor}`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* OS Context Footer Box (Wireframe Section 6) */}
      <div className="p-3 m-3 rounded-xl bg-slate-950/90 border border-slate-800/90 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-400">
            [OS Context]
          </span>
          {osContext.is_elevated ? (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <ShieldCheck className="w-3 h-3" /> Elevated
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
              <ShieldAlert className="w-3 h-3" /> Standard User
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
          <Laptop className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="truncate">
            {osContext.os_name} ({osContext.arch})
          </span>
        </div>

        <div className="text-[11px] text-slate-400 truncate" title={osContext.shell}>
          Shell: {osContext.shell}
        </div>

        <div className="space-y-1 pt-1 border-t border-slate-800/80">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-slate-400">
              Length: {osContext.total_path_length.toLocaleString()} chars
            </span>
            <span
              className={`font-semibold ${
                lengthRatio < 65
                  ? "text-emerald-400"
                  : lengthRatio < 85
                    ? "text-amber-400"
                    : "text-rose-400"
              }`}
            >
              {lengthRatio < 65 ? "Safe" : lengthRatio < 85 ? "Caution" : "Near Limit"}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                lengthRatio < 65
                  ? "bg-emerald-500"
                  : lengthRatio < 85
                    ? "bg-amber-500"
                    : "bg-rose-500"
              }`}
              style={{ width: `${Math.max(5, lengthRatio)}%` }}
            />
          </div>
          <div className="text-[10px] text-slate-500 text-right font-mono">
            Max {osContext.max_path_length.toLocaleString()} chars ({lengthRatio}%)
          </div>
        </div>
      </div>
    </aside>
  );
};
