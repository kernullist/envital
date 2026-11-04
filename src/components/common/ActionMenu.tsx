import React, { useEffect, useRef, useState } from "react";

export interface MenuAction {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
}

interface Props {
  label: string;
  icon?: React.ReactNode;
  actions: MenuAction[];
  /**
   * Where the menu opens. Use `"up"` when the trigger sits at the bottom of an
   * `overflow-hidden` pane, otherwise the menu would be clipped.
   */
  placement?: "up" | "down";
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
}

/**
 * Button that opens a list of actions.
 *
 * Like `Select`, the list is rendered by the app rather than by the platform, so
 * it stays readable under any desktop theme.
 */
export const ActionMenu: React.FC<Props> = ({
  label,
  icon,
  actions,
  placement = "down",
  className = "",
  buttonClassName = "",
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={buttonClassName}
      >
        {icon}
        <span>{label}</span>
      </button>

      {open && (
        <ul
          role="menu"
          className={`absolute z-50 w-max min-w-full rounded-lg border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50 py-1 ${
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {actions.map((action) => (
            <li key={action.id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  action.onSelect();
                }}
                className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-emerald-500/20 hover:text-emerald-100 transition flex items-start gap-2"
              >
                {action.icon && <span className="mt-0.5 shrink-0">{action.icon}</span>}
                <span className="min-w-0">
                  <span className="block font-semibold whitespace-nowrap">
                    {action.label}
                  </span>
                  {action.description && (
                    <span className="block text-[10px] text-slate-400">
                      {action.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
