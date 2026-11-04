import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /**
   * Where the option list opens. Use `"up"` when the trigger sits at the bottom
   * of an `overflow-hidden` pane, otherwise the list would be clipped.
   */
  placement?: "up" | "down";
  className?: string;
  ariaLabel?: string;
}

/**
 * Dropdown that renders its option list in the app's own (dark) palette.
 *
 * A native `<select>` popup is drawn by GTK on Linux, so with a light desktop
 * theme (e.g. Yaru) the list appeared as white-on-white and was unreadable —
 * `color` from the page was applied to the GTK menu items while the background
 * came from the theme. Rendering the list ourselves keeps it legible on any
 * desktop theme.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placement = "down",
  className = "",
  ariaLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  // Re-sync the highlighted row each time the list is opened.
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
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

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
        className="w-full flex items-center justify-between gap-2 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 transition"
      >
        <span className="truncate">{options[selectedIndex]?.label ?? ""}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute z-50 w-max min-w-full rounded-lg border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50 py-1 ${
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={`px-2.5 py-1.5 text-xs cursor-pointer flex items-center gap-2 whitespace-nowrap transition ${
                  index === activeIndex
                    ? "bg-emerald-500/20 text-emerald-100"
                    : "text-slate-200"
                }`}
              >
                <Check
                  className={`w-3 h-3 shrink-0 ${
                    isSelected ? "text-emerald-400" : "opacity-0"
                  }`}
                />
                <span>{option.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
