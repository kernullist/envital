import React, { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Header } from "./components/layout/Header";
import { Sidebar } from "./components/layout/Sidebar";
import { RightInspector } from "./components/layout/RightInspector";
import { ModalsAndToasts } from "./components/layout/ModalsAndToasts";
import { DoctorView } from "./components/doctor/DoctorView";
import { PathEditorView } from "./components/path-editor/PathEditorView";
import { ShadowingView } from "./components/shadowing/ShadowingView";
import { VariablesView } from "./components/variables/VariablesView";
import { TimeMachineView } from "./components/timemachine/TimeMachineView";
import { ProfilesView } from "./components/profiles/ProfilesView";
import { isOwnConfigWriteEvent, useEnvStore } from "./store/useEnvStore";

export const App: React.FC = () => {
  const {
    activeTab,
    loadDiagnostics,
    loadSnapshots,
    loadProfiles,
    addToast,
  } = useEnvStore();

  useEffect(() => {
    // The Time-Machine diff compares a snapshot with the current state, so the
    // environment must be loaded before the snapshot list is read: otherwise the
    // first diff is computed against an empty PATH and stays wrong until the
    // user visits the tab.
    loadDiagnostics(true).then(() => loadSnapshots());
    loadProfiles();

    // Listen to notify watcher event from Rust backend when dotfiles/configs change externally
    let unlistenFn: (() => void) | undefined;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      listen("env-external-change", () => {
        // Applying changes writes the managed block into the user's rc files;
        // the watcher sees that as a change too. Do not ask the user to
        // "refresh" because of the app's own write.
        if (isOwnConfigWriteEvent()) return;
        addToast(
          "info",
          "External Configuration Change Detected",
          "Configuration files were updated externally. Click Refresh in the header to reload."
        );
      })
        .then((fn) => {
          unlistenFn = fn;
        })
        .catch(() => {});
    }

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [loadDiagnostics, loadSnapshots, loadProfiles, addToast]);

  const showRightInspector =
    activeTab === "doctor" ||
    activeTab === "path-editor" ||
    activeTab === "shadowing";

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Top Header */}
      <Header />

      {/* 3-Pane Body (Left Sidebar + Center Main View + Right Inspector) */}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />

        <main className="flex-1 flex flex-col overflow-hidden bg-slate-950">
          {activeTab === "doctor" && <DoctorView />}
          {activeTab === "path-editor" && <PathEditorView />}
          {activeTab === "shadowing" && <ShadowingView />}
          {activeTab === "variables" && <VariablesView />}
          {activeTab === "timemachine" && <TimeMachineView />}
          {activeTab === "profiles" && <ProfilesView />}
        </main>

        {showRightInspector && <RightInspector />}
      </div>

      {/* Modals & Toasts */}
      <ModalsAndToasts />
    </div>
  );
};

export default App;
