import { useState, lazy, Suspense } from 'react';
import { useGame } from './hooks/useGame';
// Eager: the landing tab (Play/Tournament) and the always-mounted equity widget.
import { PokerTable } from './components/PokerTable';
import { EquityCalc } from './components/EquityCalc';

// Every other tab is code-split — its chunk loads only when first opened, so the
// initial bundle carries just the table you land on. These are named exports, so
// each remaps to the `{ default }` shape `lazy` expects (props stay fully typed).
const RangeGrid = lazy(() => import('./components/RangeGrid').then((m) => ({ default: m.RangeGrid })));
const PreflopTrainer = lazy(() => import('./components/PreflopTrainer').then((m) => ({ default: m.PreflopTrainer })));
const PostflopLab = lazy(() => import('./components/PostflopLab').then((m) => ({ default: m.PostflopLab })));
const PotOddsCalc = lazy(() => import('./components/PotOddsCalc').then((m) => ({ default: m.PotOddsCalc })));
const Analytics = lazy(() => import('./components/Analytics').then((m) => ({ default: m.Analytics })));
const Reference = lazy(() => import('./components/Reference').then((m) => ({ default: m.Reference })));
const LeakQuiz = lazy(() => import('./components/LeakQuiz').then((m) => ({ default: m.LeakQuiz })));
const ExploitTrainer = lazy(() => import('./components/ExploitTrainer').then((m) => ({ default: m.ExploitTrainer })));
const Replay = lazy(() => import('./components/Replay').then((m) => ({ default: m.Replay })));
const EquityDrill = lazy(() => import('./components/EquityDrill').then((m) => ({ default: m.EquityDrill })));
const BetSizingDrill = lazy(() => import('./components/BetSizingDrill').then((m) => ({ default: m.BetSizingDrill })));
// antd lives only here — kept split so it never bloats the initial load.
const PrinciplesPanel = lazy(() => import('./components/PrinciplesPanel').then((m) => ({ default: m.PrinciplesPanel })));

const DEFAULT_PROFILES = ['tag', 'lag', 'lp', 'gto', 'nit'];

type Tab = 'play' | 'tournament' | 'charts' | 'trainer' | 'lab' | 'quiz' | 'exploit' | 'replay' | 'principles' | 'odds' | 'eqdrill' | 'sizing' | 'analytics' | 'reference';

const TABS: { id: Tab; label: string }[] = [
  { id: 'play', label: '♠ Play vs Bots' },
  { id: 'tournament', label: '🏆 Tournament' },
  { id: 'charts', label: 'Preflop Charts' },
  { id: 'trainer', label: 'Range Trainer' },
  { id: 'lab', label: 'Postflop Lab' },
  { id: 'quiz', label: 'Leak Quiz' },
  { id: 'exploit', label: '🎯 Read & Exploit' },
  { id: 'replay', label: 'Hand Review' },
  { id: 'principles', label: '📓 Principles' },
  { id: 'odds', label: 'Pot Odds' },
  { id: 'eqdrill', label: '🧠 Equity Drill' },
  { id: 'sizing', label: '💰 Bet Sizing' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'reference', label: 'Reference' },
];

export default function App() {
  const g = useGame(DEFAULT_PROFILES);
  // open on whichever session was last live (cash vs tournament) so a refresh
  // lands on the matching tab.
  const [tab, setTab] = useState<Tab>(g.mode === 'tourney' ? 'tournament' : 'play');
  const [hudEnabled, setHudEnabled] = useState(true);

  // The Play and Tournament tabs are the two persisted game sessions; entering
  // one swaps the live table to its slot (other tabs leave the session as-is).
  const selectTab = (t: Tab) => {
    if (t === 'play') g.setActiveMode('cash');
    else if (t === 'tournament') g.setActiveMode('tourney');
    setTab(t);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <span className="suit black">♠</span> Poker Trainer{' '}
          <span className="suit red">♥</span>
        </h1>
        <p>
          6-max No-Limit Hold'em · cash &amp; tournament · play vs AI archetypes with a live equity /
          pot-odds HUD and GTO-baseline feedback
        </p>
      </header>

      <nav className="app-nav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="app-main">
       <Suspense fallback={<div className="card"><p className="sub">Loading…</p></div>}>
        {(tab === 'play' || tab === 'tournament') && (
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
            <PrinciplesPanel g={g} />
          </div>
        )}
        {tab === 'odds' && (
          <div className="content-col">
            <PotOddsCalc />
          </div>
        )}
        {tab === 'eqdrill' && (
          <div className="content-col">
            <EquityDrill />
          </div>
        )}
        {tab === 'sizing' && (
          <div className="content-col">
            <BetSizingDrill />
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
       </Suspense>
      </main>

      <EquityCalc />

      <footer className="app-footer">
        Runs 100% locally · nothing leaves your machine · ranges &amp; feedback are training baselines,
        not guarantees. Play responsibly.
      </footer>
    </div>
  );
}
