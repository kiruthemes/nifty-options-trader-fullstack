import React, { useEffect, useState } from "react";
import Shell from "./layout/Shell.jsx";
import { ToastProvider } from "./components/Toaster.jsx";
export default function App() {
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "light");
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("theme", theme);
  }, [theme]);
  return (
    <ToastProvider>
      <div className="ivy">
        <Shell theme={theme} onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />
      </div>
    </ToastProvider>
  );
}
