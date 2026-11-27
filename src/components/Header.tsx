import React from 'react';

export type NavTab = 'analyze' | 'history' | 'specs' | 'about';

interface HeaderProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  systemStatus?: string;
}

const NAV_ITEMS: Array<{ id: NavTab; label: string }> = [
  { id: 'analyze', label: 'Analyze' },
  { id: 'history', label: 'History' },
  { id: 'specs', label: 'Model Specs' },
  { id: 'about', label: 'About' }
];

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onTabChange,
  systemStatus = 'CONNECTING...'
}) => {
  // The indicator must reflect the supplied health state. The previous UI
  // displayed a pulsing green dot even when the API was offline or retrying.
  const normalizedStatus = systemStatus.toLowerCase();
  const statusTone = /offline|disconnected|error|failed|unavailable/.test(normalizedStatus)
    ? 'offline'
    : /connecting|initializing|retry|unknown/.test(normalizedStatus)
      ? 'pending'
      : 'online';

  const statusStyles = {
    online: {
      dot: 'bg-emerald-500 animate-pulse',
      text: 'text-emerald-700',
      label: 'Connected'
    },
    pending: {
      dot: 'bg-amber-500',
      text: 'text-amber-700',
      label: 'Checking'
    },
    offline: {
      dot: 'bg-red-500',
      text: 'text-red-700',
      label: 'Unavailable'
    }
  }[statusTone];

  return (
    <header className="min-h-16 bg-white border-b border-slate-200 flex flex-wrap items-center gap-x-4 gap-y-2 px-3 sm:px-6 lg:px-8 py-2 justify-between z-10 shrink-0">
      <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-8">
        <button
          type="button"
          onClick={() => onTabChange('analyze')}
          aria-label="TruthLens AI home"
          className="shrink-0 font-black text-lg sm:text-xl tracking-tighter uppercase text-slate-900 hover:opacity-90 transition-opacity flex items-center text-left"
        >
          TruthLens<span className="text-red-600">AI</span>
        </button>
        <nav
          aria-label="Main navigation"
          className="flex min-w-0 flex-1 gap-4 sm:gap-6 overflow-x-auto whitespace-nowrap text-[11px] sm:text-sm font-semibold text-slate-500 uppercase tracking-wider sm:tracking-widest"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onTabChange(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`shrink-0 border-b-2 pb-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 ${
                  isActive
                    ? 'text-slate-900 border-slate-900 font-bold'
                    : 'border-transparent hover:text-slate-900'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        <div className="flex flex-col items-end">
          <span className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase leading-none mb-1">
            API Status
          </span>
          <div className="flex items-center gap-1.5" role="status" aria-live="polite">
            <span className={`h-2 w-2 rounded-full ${statusStyles.dot}`} aria-hidden="true" />
            <span className={`text-[10px] sm:text-xs font-mono font-bold ${statusStyles.text}`}>
              {systemStatus}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};
