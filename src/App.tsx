import { useState, lazy, Suspense } from 'react';
import { useGame } from './hooks/useGame';
import { PokerTable } from './components/PokerTable';
import { RangeGrid } from './components/RangeGrid';
import { PreflopTrainer } from './components/PreflopTrainer';
import { PostflopLab } from './components/PostflopLab';
import { PotOddsCalc } from './components/PotOddsCalc';
import { Analytics } from './components/Analytics';
import { Reference } from './components/Reference';
import { LeakQuiz } from './components/LeakQuiz';
import { ExploitTrainer } from './components/ExploitTrainer';
import { Replay } from './components/Replay';

// antd lives only in the Principles panel — lazy-load it so the main bundle stays lean.
const PrinciplesPanel = lazy(() =>
  import('./components/PrinciplesPanel').then((m) => ({ default: m.PrinciplesPanel })),
);

const DEFAULT_PROFILES = ['tag', 'lag', 'lp', 'gto', 'nit'];

type Tab = 'play' | 'charts' | 'trainer' | 'lab' | 'quiz' | 'exploit' | 'replay' | 'principles' | 'odds' | 'analytics' | 'reference';

const TABS: { id: Tab; label: string }[] = [
  { id: 'play', label: '♠ Play vs Bots' },
  { id: 'charts', label: 'Preflop Charts' },
  { id: 'trainer', label: 'Range Trainer' },
  { id: 'lab', label: 'Postflop Lab' },
  { id: 'quiz', label: 'Leak Quiz' },
  { id: 'exploit', label: '🎯 Read & Exploit' },
  { id: 'replay', label: 'Hand Review' },
  { id: 'principles', label: '📓 Principles' },
  { id: 'odds', label: 'Pot Odds' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'reference', label: 'Reference' },
];

export default function App() {
  const g = useGame(DEFAULT_PROFILES);
  const [tab, setTab] = useState<Tab>('play');
  const [hudEnabled, setHudEnabled] = useState(true);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <span className="suit black">♠</span> Poker Trainer{' '}
          <span className="suit red">♥</span>
        </h1>
        <p>
          6-max No-Limit Hold'em · 100bb · play vs AI archetypes with a live equity / pot-odds HUD and
          GTO-baseline feedback
        </p>
      </header>

      <nav className="app-nav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {tab === 'play' && (
          <PokerTable g={g} hudEnabled={hudEnabled} onToggleHud={() => setHudEnabled((v) => !v)} />
        )}
        {tab === 'charts' && (
          <div className="content-col">
            <RangeGrid />
          </div>
        )}
        {tab === 'trainer' && (
          <div className="content-col">
            <PreflopTrainer />
          </div>
        )}
        {tab === 'lab' && (
          <div className="content-col">
            <PostflopLab />
          </div>
        )}
        {tab === 'quiz' && (
          <div className="content-col">
            <LeakQuiz g={g} />
          </div>
        )}
        {tab === 'exploit' && (
          <div className="content-col">
            <ExploitTrainer />
          </div>
        )}
        {tab === 'replay' && (
          <div className="content-col">
            <Replay g={g} />
          </div>
        )}
        {tab === 'principles' && (
          <div className="content-col">
            <Suspense fallback={<div className="card"><p className="sub">Loading…</p></div>}>
              <PrinciplesPanel g={g} />
            </Suspense>
          </div>
        )}
        {tab === 'odds' && (
          <div className="content-col">
            <PotOddsCalc />
          </div>
        )}
        {tab === 'analytics' && (
          <div className="content-col">
            <Analytics g={g} />
          </div>
        )}
        {tab === 'reference' && (
          <div className="content-col">
            <Reference />
          </div>
        )}
      </main>

      <footer className="app-footer">
        Runs 100% locally · nothing leaves your machine · ranges &amp; feedback are training baselines,
        not guarantees. Play responsibly.
      </footer>
    </div>
  );
}
