import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  FolderKanban,
  Layers,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import { isWindowsPlatform } from "../../types/ipc";
import { confirmAction } from "../../utils/confirmAction";

export const ProfilesView: React.FC = () => {
  const {
    profiles,
    loadProfiles,
    saveCurrentAsProfile,
    applyProfileToStage,
    deleteProfile,
    upsertVariable,
  } = useEnvStore();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const handleDeleteProfile = async (profileId: string, profileName: string) => {
    const confirmed = await confirmAction(
      `Delete the profile "${profileName}"? This cannot be undone.`,
      { title: "Delete profile", okLabel: "Delete" }
    );
    if (!confirmed) return;
    await deleteProfile(profileId);
  };

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await saveCurrentAsProfile(
      name.trim(),
      description.trim() || "Custom development environment profile"
    );
    setName("");
    setDescription("");
  };

  const windows = isWindowsPlatform();
  const quickTemplates = [
    {
      title: "☕ Java 17 LTS Project",
      desc: windows
        ? "Sets JAVA_HOME to the Adoptium JDK 17 installation directory."
        : "Sets JAVA_HOME to the OpenJDK 17 directory (edit it if yours differs).",
      key: "JAVA_HOME",
      value: windows
        ? "C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.10"
        : "/usr/lib/jvm/java-17-openjdk-amd64",
    },
    {
      title: "☕ Java 21 LTS Project",
      desc: windows
        ? "Sets JAVA_HOME to the Adoptium JDK 21 installation directory."
        : "Sets JAVA_HOME to the OpenJDK 21 directory (edit it if yours differs).",
      key: "JAVA_HOME",
      value: windows
        ? "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.2"
        : "/usr/lib/jvm/java-21-openjdk-amd64",
    },
    {
      title: "🐍 Python UTF-8 & PyTorch",
      desc: "Enables PYTHONUTF8=1 environment variable.",
      key: "PYTHONUTF8",
      value: "1",
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-base font-bold text-slate-100 flex items-center gap-2">
          <FolderKanban className="w-5 h-5 text-violet-400" />
          <span>🗂️ Environment Profiles (One-Click Switching)</span>
        </h1>
        <p className="text-xs text-slate-400">
          Save project-specific environment variables and PATH configurations as reusable profiles and switch between them in one click.
        </p>
      </div>

      {/* Create Profile Form */}
      <form
        onSubmit={handleSave}
        className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3"
      >
        <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
          <Plus className="w-4 h-4 text-violet-400" />
          <span>Save Current Staged Environment (PATH + Variables) as New Profile</span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Profile name (e.g., Java 21 Microservice Stack)"
            className="flex-1 min-w-[220px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (e.g., Enables JDK 21 + Maven + Docker)"
            className="flex-1 min-w-[220px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-violet-500"
          />
          <button
            type="submit"
            className="px-4 py-1.5 rounded-lg bg-violet-500 hover:bg-violet-400 text-slate-950 font-bold text-xs transition"
          >
            Save Profile
          </button>
        </div>
      </form>

      {/* Quick Preset Templates */}
      <div className="space-y-2.5">
        <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <span>Quick Preset Switcher</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {quickTemplates.map((tpl) => (
            <div
              key={tpl.title}
              className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 flex flex-col justify-between gap-3"
            >
              <div>
                <div className="text-xs font-bold text-slate-100">
                  {tpl.title}
                </div>
                <p className="text-[11px] text-slate-400 mt-1">{tpl.desc}</p>
                <div className="mt-2 font-mono text-[11px] text-emerald-300 bg-slate-950 px-2 py-1 rounded border border-slate-800 truncate">
                  {tpl.key}={tpl.value}
                </div>
              </div>
              <button
                onClick={() =>
                  upsertVariable({
                    key: tpl.key,
                    value: tpl.value,
                    is_expandable: false,
                    scope: "User",
                    is_modified: true,
                  })
                }
                className="w-full py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition"
              >
                Stage Preset Variable
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Saved Profiles */}
      <div className="space-y-2.5">
        <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-violet-400" />
          <span>Saved User Profiles ({profiles.length})</span>
        </div>

        {profiles.length === 0 ? (
          <div className="p-8 rounded-2xl bg-slate-900/40 border border-slate-800 text-center text-xs text-slate-400">
            No custom profiles saved yet. Use the form above to save your current environment as a profile.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {profiles.map((prof) => (
              <div
                key={prof.id}
                className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-100">
                      {prof.name}
                    </span>
                    <span className="text-[11px] font-mono text-slate-500">
                      {prof.created_at}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">{prof.description}</p>
                  <div className="text-[11px] text-slate-400 pt-1">
                    PATH Entries: <strong>{prof.path_entries.length}</strong> ·
                    Variables: <strong>{prof.variables.length}</strong>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800/80">
                  <button
                    onClick={() => handleDeleteProfile(prof.id, prof.name)}
                    className="p-1.5 rounded-lg border border-slate-800 bg-slate-950 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition"
                    title="Delete profile"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => applyProfileToStage(prof)}
                    className="px-3.5 py-1.5 rounded-lg bg-violet-500 hover:bg-violet-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>One-Click Switch</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
