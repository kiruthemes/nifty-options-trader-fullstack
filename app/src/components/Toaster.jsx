// src/components/Toaster.jsx
import React, { createContext, useContext, useMemo, useState } from "react";

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const api = useMemo(
    () => ({
      add(t) {
        const id = crypto.randomUUID();
        const item = { id, type: t.type || "info", title: t.title || "", desc: t.desc || "" };
        setItems((prev) => [...prev, item]);
        setTimeout(() => remove(id), t.ttl ?? 3000);
        return id;
      },
      remove,
    }),
    []
  );

  function remove(id) {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed top-3 right-3 z-[1000] space-y-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg shadow px-3 py-2 text-sm border bg-white dark:bg-blue-gray-900 dark:border-blue-gray-800 ${
              t.type === "success"
                ? "border-emerald-200 text-emerald-800 dark:text-emerald-300"
                : t.type === "error"
                ? "border-red-200 text-red-800 dark:text-red-300"
                : "border-blue-gray-200 text-ink-700 dark:text-blue-gray-200"
            }`}
          >
            <div className="font-semibold">{t.title}</div>
            {t.desc && <div className="opacity-80">{t.desc}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
