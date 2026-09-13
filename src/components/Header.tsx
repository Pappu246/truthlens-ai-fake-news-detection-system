import React from 'react';

export type NavTab = 'analyze' | 'history' | 'specs' | 'about';

interface HeaderProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  systemStatus?: string;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onTabChange,
  systemStatus = 'ACTIVE // v2.4.1'
}) => {
  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center px-6 lg:px-8 justify-between z-10 shrink-0">
      <div className="flex items-center gap-8">
        <button
          onClick={() => onTabChange('analyze')}
          className="font-black text-xl tracking-tighter uppercase text-slate-900 hover:opacity-90 transition-opacity flex items-center text-left"
        >
          TruthLens<span className="text-red-600">AI</span>
        </button>
        <nav className="flex gap-4 sm:gap-6 text-xs sm:text-sm font-semibold text-slate-500 uppercase tracking-widest">
          <button
            onClick={() => onTabChange('analyze')}
            className={`pb-1 transition-colors ${
              activeTab === 'analyze'
                ? 'text-slate-900 border-b-2 border-slate-900 font-bold'
                : 'hover:text-slate-900'
            }`}
          >
            Analyze
          </button>
          <button
            onClick={() => onTabChange('history')}
            className={`pb-1 transition-colors ${
              activeTab === 'history'
                ? 'text-slate-900 border-b-2 border-slate-900 font-bold'
                : 'hover:text-slate-900'
            }`}
          >
            History
          </button>
          <button
            onClick={() => onTabChange('specs')}
            className={`pb-1 transition-colors ${
              activeTab === 'specs'
                ? 'text-slate-900 border-b-2 border-slate-900 font-bold'
                : 'hover:text-slate-900'
            }`}
          >
            Model Specs
          </button>
          <button
            onClick={() => onTabChange('about')}
            className={`pb-1 transition-colors ${
              activeTab === 'about'
                ? 'text-slate-900 border-b-2 border-slate-900 font-bold'
                : 'hover:text-slate-900'
            }`}
          >
            About
          </button>
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-end">
          <span className="text-[10px] font-bold text-slate-400 uppercase leading-none mb-1">System Status</span>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            <span className="text-xs font-mono text-green-600 font-bold">{systemStatus}</span>
          </div>
        </div>
      </div>
    </header>
  );
};
