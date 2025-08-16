import React, { useEffect, useMemo, useState } from 'react'
import Sidebar from './Sidebar.jsx'
import Topbar from './Topbar.jsx'
import Dashboard from '../pages/Dashboard.jsx'

export default function Shell({ theme, onToggleTheme }) {
  // user's preference (persisted)
  const [collapsedPref, setCollapsedPref] = useState(() => {
    return localStorage.getItem('sidebar.collapsed') === '1'
  })
  // responsive override
  const [forcedCollapsed, setForcedCollapsed] = useState(() => window.innerWidth < 1280)

  // effective state = user pref OR forced due to small width
  const collapsed = useMemo(() => collapsedPref || forcedCollapsed, [collapsedPref, forcedCollapsed])

  useEffect(() => {
    const onResize = () => setForcedCollapsed(window.innerWidth < 1280)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // keyboard shortcut: '[' toggles collapse (when not typing in inputs)
  useEffect(() => {
    const handler = (e) => {
      if (e.key === '[' || e.code === 'BracketLeft') {
        const tag = (e.target?.tagName || '').toLowerCase()
        const isTyping = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable
        if (!isTyping) {
          e.preventDefault()
          setCollapsedPref((c) => {
            const next = !c
            localStorage.setItem('sidebar.collapsed', next ? '1' : '0')
            return next
          })
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const gridCols = collapsed ? 'lg:grid-cols-[4rem,1fr]' : 'lg:grid-cols-[18rem,1fr]'

  return (
    <div className="ivy p-3 max-w-[1600px] mx-auto">
      <div className={`grid grid-cols-1 ${gridCols} gap-3`}>
        <Sidebar
          collapsed={collapsed}
          onToggleCollapse={() =>
            setCollapsedPref((c) => {
              const next = !c
              localStorage.setItem('sidebar.collapsed', next ? '1' : '0')
              return next
            })
          }
          onToggleTheme={onToggleTheme}
          hotkeyHint="["
        />
        <div className="flex flex-col gap-3">
          <Topbar theme={theme} onToggleTheme={onToggleTheme} />
          <Dashboard />
        </div>
      </div>
    </div>
  )
}
