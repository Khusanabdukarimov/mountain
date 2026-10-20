import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { ErrorBoundary } from './ErrorBoundary';
import { CommandPalette } from './CommandPalette';
import { SubscriptionBanner } from './SubscriptionBanner';
import { useLocalStorage } from '@/hooks/useLocalStorage';

export function AppLayout() {
  const [collapsed, setCollapsed] = useLocalStorage<boolean>('sidebar.collapsed', false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Auto-collapse on tablet (<1280px) but only on first mount
  useEffect(() => {
    const w = window.innerWidth;
    if (w >= 768 && w < 1280) setCollapsed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close mobile drawer on route change
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed(c => !c)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <main className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
        {/* Mobile burger floating button — visible only on <md and when sidebar closed */}
        <button
          type="button"
          className="md:hidden fixed top-3 left-3 z-20 w-9 h-9 rounded-lg bg-bg2 border border-border shadow-md flex items-center justify-center hover:bg-bg3"
          onClick={() => setMobileOpen(true)}
          aria-label="Sidebar ochish"
        >
          <Menu className="w-4 h-4 text-text" />
        </button>
        <SubscriptionBanner />
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <CommandPalette />
    </div>
  );
}
