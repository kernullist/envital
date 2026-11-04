import React, { useState } from "react";
import {
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  Package,
  Plus,
  Trash2,
} from "lucide-react";
import { useEnvStore } from "../../store/useEnvStore";
import { Select } from "../common/Select";
import {
  formatScopeInfo,
  isAppManagedConfigFile,
  isSecretVariableKey,
  isWindowsPlatform,
  valueLooksExpandable,
  type Scope,
} from "../../types/ipc";

export const VariablesView: React.FC = () => {
  const {
    variables,
    globalSearch,
    upsertVariable,
    deleteVariable,
    addToast,
  } = useEnvStore();

  const [scopeTab, setScopeTab] = useState<"all" | "user" | "system" | "process">(
    "all"
  );
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [editingVar, setEditingVar] = useState<{
    originalKey?: string;
    /** Scope of the row being edited, so a scope change moves it instead of copying it. */
    originalScope?: Scope;
    key: string;
    value: string;
    scope: Scope;
    is_expandable: boolean;
    expandableTouched?: boolean;
  } | null>(null);

  const toggleReveal = (id: string) => {
    setRevealedKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const filteredVars = variables.filter((v) => {
    const info = formatScopeInfo(v.scope);
    if (scopeTab === "user" && info.kind !== "user" && info.kind !== "dotfile")
      return false;
    if (scopeTab === "system" && info.kind !== "system") return false;
    if (scopeTab === "process" && info.kind !== "process") return false;
    if (scopeTab === "all" && info.kind === "process") return false; // Hide noisy process vars by default unless 'process' tab selected

    if (!globalSearch.trim()) return true;
    const q = globalSearch.toLowerCase();
    return (
      v.key.toLowerCase().includes(q) ||
      ((!isSecretVariableKey(v.key) ||
        !!revealedKeys[
          typeof v.scope === "object" && v.scope !== null && "Dotfile" in v.scope
            ? `${v.scope.Dotfile.file_path}:${v.scope.Dotfile.line_number}-${v.key}`
            : `${v.scope}-${v.key}`
        ]) &&
        v.value.toLowerCase().includes(q))
    );
  });

  const windows = isWindowsPlatform();

  // Windows expands `%VAR%` inside REG_EXPAND_SZ; Linux expands `$VAR` and a
  // leading `~` when env.sh is sourced by the shell.
  const looksExpandable = valueLooksExpandable;

  const handleSaveModal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVar || !editingVar.key.trim()) return;
    const key = editingVar.key.trim();
    // On Linux the key becomes `export <key>=...` in env.sh, so it has to be a
    // real shell name. Other platforms (the registry) do not have that limit.
    if (!windows && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      addToast(
        "error",
        "Invalid Variable Name",
        `'${key}' is not a valid shell variable name. Use only letters, digits and underscores, and do not start with a digit.`
      );
      return;
    }
    // env.sh stores one variable per line and is scanned line by line. A value
    // with a line break would be truncated the next time the app reads it (and
    // then overwritten on the following Apply), so refuse it here instead of
    // losing the rest of the value. Windows stores values in the registry,
    // where line breaks are fine.
    if (!windows && /[\r\n]/.test(editingVar.value)) {
      addToast(
        "error",
        "Invalid Variable Value",
        "A value written to env.sh must be a single line: the file is scanned line by line, so a line break would cut the value short. Replace it with spaces or keep the multi-line text in a file."
      );
      return;
    }
    const staged = upsertVariable(
      {
        key,
        value: editingVar.value,
        // The checkbox is the source of truth. Forcing expansion on whenever the
        // text contains `$` made it impossible to store a literal token such as
        // `pa$$word`, and Apply would then expand it in every new shell.
        is_expandable: editingVar.is_expandable,
        scope: editingVar.scope,
        is_modified: true,
      },
      editingVar.originalKey,
      editingVar.originalScope
    );
    if (!staged) {
      // The store refused (another re-analysis is running, or the name already
      // exists). Keep the dialog open so the typed value is not lost.
      return;
    }
    setEditingVar(null);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-5 space-y-4">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Package className="w-5 h-5 text-emerald-400" />
            <span>📦 Environment Variables (Secret Masking &amp; Type Preservation)</span>
          </h1>
          <p className="text-xs text-slate-400">
            Sensitive keys (KEY, SECRET, TOKEN, PASSWORD, etc.) are automatically masked as{" "}
            <code className="text-slate-300">••••••••</code> to prevent screen-sharing leaks, and{" "}
            {windows ? (
              <>
                Windows{" "}
                <code className="text-slate-300">REG_EXPAND_SZ</code> types are strictly
                preserved.
              </>
            ) : (
              <>
                values that use{" "}
                <code className="text-slate-300">$VARS</code> stay expandable when they
                are written to <code className="text-slate-300">env.sh</code>.
              </>
            )}
          </p>
        </div>

        <button
          onClick={() =>
            setEditingVar({
              key: "",
              value: "",
              scope: "User",
              is_expandable: false,
            })
          }
          className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition"
        >
          <Plus className="w-4 h-4" />
          <span>Add Variable</span>
        </button>
      </div>

      {/* Scope Filter Tabs */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
          {[
            { id: "all", label: "Persistent (User + System + Dotfile)" },
            { id: "user", label: "User / Dotfile" },
            { id: "system", label: "System (HKLM)" },
            { id: "process", label: "Runtime Session (Process)" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setScopeTab(t.id as typeof scopeTab)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                scopeTab === t.id
                  ? "bg-emerald-500 text-slate-950 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400 font-mono">
          {filteredVars.length} variables
        </span>
      </div>

      {/* Variables Table */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/60 divide-y divide-slate-800/80">
        {filteredVars.map((v) => {
          const scopeInfo = formatScopeInfo(v.scope);
          // The badge is only the file's base name, so two files with the same
          // name (`.bashrc` in two directories) would produce the same key and
          // React would drop one of the rows.
          const uniqueId =
            typeof v.scope === "object" &&
            v.scope !== null &&
            "Dotfile" in v.scope
              ? `${v.scope.Dotfile.file_path}:${v.scope.Dotfile.line_number}-${v.key}`
              : `${v.scope}-${v.key}`;
          const isSecret = isSecretVariableKey(v.key);
          const isRevealed = !!revealedKeys[uniqueId];
          // Apply only writes the app's env.sh; it cannot remove an `export`
          // from the user's own .bashrc, so deleting such a row would report a
          // success that the next scan immediately reverts.
          const ownDeclarationSource =
            typeof v.scope === "object" &&
            v.scope !== null &&
            "Dotfile" in v.scope &&
            !isAppManagedConfigFile(v.scope.Dotfile.file_path)
              ? `${v.scope.Dotfile.file_path}:${v.scope.Dotfile.line_number}`
              : null;

          return (
            <div
              key={uniqueId}
              className="px-4 py-3 hover:bg-slate-900/90 flex items-center justify-between gap-4 transition"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                      scopeInfo.kind === "system"
                        ? "bg-indigo-500/15 text-indigo-300 border-indigo-500/30"
                        : scopeInfo.kind === "user"
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                          : scopeInfo.kind === "dotfile"
                            ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                            : "bg-slate-800 text-slate-400 border-slate-700"
                    }`}
                  >
                    [{scopeInfo.badge}]
                  </span>

                  <span className="font-mono text-xs font-bold text-slate-100">
                    {v.key}
                  </span>

                  {v.is_expandable && (
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30"
                      title={
                        windows
                          ? "Stored as a REG_EXPAND_SZ value: %VARS% expand when it is read"
                          : "Expanded by the shell when env.sh is sourced: $VARS and a leading ~ expand"
                      }
                    >
                      {windows ? "REG_EXPAND_SZ" : "EXPANDS"}
                    </span>
                  )}

                  {isSecret && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                      <Lock className="w-2.5 h-2.5" /> Secret Masked
                    </span>
                  )}

                  {v.is_modified && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">
                      Staged
                    </span>
                  )}

                  {scopeInfo.vscodeUrl && (
                    <a
                      href={scopeInfo.vscodeUrl}
                      className="text-[10px] text-sky-400 hover:text-sky-300 flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3" /> Open in VS Code
                    </a>
                  )}
                </div>

                <div className="font-mono text-xs text-slate-300 break-all">
                  {isSecret && !isRevealed ? (
                    <span className="tracking-widest text-slate-500 select-none">
                      ••••••••••••••••••••••••
                    </span>
                  ) : (
                    v.value
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {isSecret && (
                  <button
                    onClick={() => toggleReveal(uniqueId)}
                    className="p-1.5 rounded-lg border border-slate-800 bg-slate-950 hover:bg-slate-800 text-slate-300 transition"
                    title={isRevealed ? "Hide secret value" : "Reveal secret value"}
                  >
                    {isRevealed ? (
                      <EyeOff className="w-3.5 h-3.5 text-amber-400" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}

                <button
                  onClick={() => {
                    navigator.clipboard
                      .writeText(v.value)
                      .then(() =>
                        addToast("info", `Copied value of '${v.key}' to clipboard.`)
                      )
                      .catch(() =>
                        addToast(
                          "error",
                          "Clipboard Unavailable",
                          "The desktop did not allow clipboard access."
                        )
                      );
                  }}
                  className="p-1.5 rounded-lg border border-slate-800 bg-slate-950 hover:bg-slate-800 text-slate-300 transition"
                  title="Copy value"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>

                {v.scope !== "Process" && (
                  <>
                    <button
                      onClick={() =>
                        setEditingVar({
                          originalKey: v.key,
                          originalScope: v.scope,
                          key: v.key,
                          value: v.value,
                          scope: v.scope,
                          is_expandable: v.is_expandable,
                        })
                      }
                      className="p-1.5 rounded-lg border border-slate-800 bg-slate-950 hover:bg-slate-800 text-slate-300 transition"
                      title="Edit variable"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    {ownDeclarationSource ? (
                      <button
                        disabled
                        className="p-1.5 rounded-lg border border-slate-800 bg-slate-950 text-slate-600 cursor-not-allowed"
                        title={`Declared in ${ownDeclarationSource}. Apply only writes ~/.config/env-doctor/env.sh, so delete it in that file instead.`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => deleteVariable(v.key, v.scope)}
                        className="p-1.5 rounded-lg border border-slate-800 bg-slate-950 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition"
                        title="Delete variable"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add / Edit Variable Modal */}
      {editingVar && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveModal}
            className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden"
          >
            <div className="p-4 border-b border-slate-800 font-bold text-sm text-slate-100">
              {editingVar.originalKey
                ? `Edit Environment Variable (${editingVar.originalKey})`
                : "Add New Environment Variable"}
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 font-semibold mb-1">
                  Scope
                </label>
                {windows ? (
                  <Select
                    value={editingVar.scope === "System" ? "System" : "User"}
                    onChange={(next) =>
                      setEditingVar({ ...editingVar, scope: next })
                    }
                    ariaLabel="Scope for this environment variable"
                    className="w-full"
                    options={[
                      {
                        value: "User",
                        label: "User scope (HKCU / ~/.config/env-doctor)",
                      },
                      { value: "System", label: "System scope (HKLM)" },
                    ]}
                  />
                ) : (
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Linux: the edited value is written to{" "}
                    <code className="text-slate-300">~/.config/env-doctor/env.sh</code>{" "}
                    on Apply and loaded by new shells, overriding the value from
                    other files.
                    {typeof editingVar.scope === "object" &&
                      editingVar.scope !== null &&
                      "Dotfile" in editingVar.scope && (
                        <>
                          {" "}
                          It was read from{" "}
                          <code className="text-slate-300">
                            {editingVar.scope.Dotfile.file_path}:{editingVar.scope.Dotfile.line_number}
                          </code>
                          .
                        </>
                      )}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-slate-400 font-semibold mb-1">
                  Variable Key
                </label>
                <input
                  type="text"
                  required
                  value={editingVar.key}
                  onChange={(e) =>
                    setEditingVar({ ...editingVar, key: e.target.value })
                  }
                  placeholder="e.g., JAVA_HOME, GOPATH, OPENAI_API_KEY"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-semibold mb-1">
                  Variable Value
                </label>
                <textarea
                  rows={3}
                  value={editingVar.value}
                  onChange={(e) => {
                    const value = e.target.value;
                    setEditingVar({
                      ...editingVar,
                      value,
                      // A new variable follows its text until the user makes an
                      // explicit choice. Editing an existing variable keeps the
                      // stored mode, so a literal `pa$$word` does not silently
                      // become a template (or the reverse).
                      is_expandable:
                        editingVar.expandableTouched || editingVar.originalKey
                          ? editingVar.is_expandable
                          : looksExpandable(value),
                    });
                  }}
                  placeholder={
                    windows
                      ? "e.g., C:\\Program Files\\Java\\jdk-21"
                      : "e.g., /usr/lib/jvm/java-21-openjdk-amd64 or $HOME/.local/share/tool"
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editingVar.is_expandable}
                  onChange={(e) =>
                    setEditingVar({
                      ...editingVar,
                      is_expandable: e.target.checked,
                      expandableTouched: true,
                    })
                  }
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500"
                />
                <span>
                  {windows ? (
                    <>
                      Store as expandable string (
                      <code className="text-sky-300">REG_EXPAND_SZ</code>)
                      (auto-enabled for new values that use{" "}
                      <code className="text-sky-300">%VAR%</code>)
                    </>
                  ) : (
                    <>
                      Expand <code className="text-sky-300">$VARS</code> and a leading{" "}
                      <code className="text-sky-300">~</code> when the value is loaded
                      (auto-enabled for new values that use them; a value already
                      stored literally stays literal)
                    </>
                  )}
                </span>
              </label>
            </div>
            <div className="p-3.5 bg-slate-950 border-t border-slate-800 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingVar(null)}
                className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs"
              >
                Stage Variable
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
