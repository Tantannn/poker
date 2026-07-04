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
const MathDrill = lazy(() => import('./components/MathDrill').then((m) => ({ default: m.MathDrill })));
const MentalGame = lazy(() => import('./components/MentalGame').then((m) => ({ default: m.MentalGame })));
const FlopHeatmap = lazy(() => import('./components/FlopHeatmap').then((m) => ({ default: m.FlopHeatmap })));
const Curriculum = lazy(() => import('./components/Curriculum').then((m) => ({ default: m.Curriculum })));
const Gameplan = lazy(() => import('./components/Gameplan').then((m) => ({ default: m.Gameplan })));
const Review = lazy(() => import('./components/Review').then((m) => ({ default: m.Review })));
const BankrollSim = lazy(() => import('./components/BankrollSim').then((m) => ({ default: m.BankrollSim })));
const Settings = lazy(() => import('./components/Settings').then((m) => ({ default: m.Settings })));
const PrinciplesPanel = lazy(() => import('./components/PrinciplesPanel').then((m) => ({ default: m.PrinciplesPanel })));

const DEFAULT_PROFILES = ['tag', 'lag', 'lp', 'gto', 'nit'];

type Tab = 'learn' | 'play' | 'tournament' | 'charts' | 'trainer' | 'lab' | 'gameplan' | 'quiz' | 'exploit' | 'replay' | 'principles' | 'odds' | 'eqdrill' | 'mathdrill' | 'review' | 'sizing' | 'bankroll' | 'mental' | 'heatmap' | 'analytics' | 'reference' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'learn', label: '🎓 Learning Path' },
  { id: 'play', label: '♠ Play vs Bots' },
  { id: 'tournament', label: '🏆 Tournament' },
  { id: 'charts', label: 'Preflop Charts' },
  { id: 'trainer', label: 'Range Trainer' },
  { id: 'lab', label: 'Postflop Lab' },
  { id: 'heatmap', label: '🔥 Flop Heatmap' },
  { id: 'gameplan', label: '📋 Gameplan' },
  { id: 'quiz', label: 'Leak Quiz' },
  { id: 'exploit', label: '🎯 Read & Exploit' },
  { id: 'replay', label: 'Hand Review' },
  { id: 'principles', label: '📓 Principles' },
  { id: 'odds', label: 'Pot Odds' },
  { id: 'eqdrill', label: '🧠 Equity Drill' },
  { id: 'mathdrill', label: '🧮 Math Trainer' },
  { id: 'review', label: '🔁 Review' },
  { id: 'sizing', label: '💰 Bet Sizing' },
  { id: 'bankroll', label: '💵 Bankroll' },
  { id: 'mental', label: '🧘 Mental Game' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'reference', label: 'Reference' },
  { id: 'settings', label: '⚙ Settings' },
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

      <nav className="app-nav" role="tablist" aria-label="Trainer sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="app-main">
       <Suspense fallback={<div className="card"><p className="sub">Loading…</p></div>}>
        {tab === 'learn' && (
          <div className="content-col">
            <Curriculum onGo={(t) => selectTab(t as Tab)} />
          </div>
        )}
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
        {tab === 'heatmap' && (
          <div className="content-col">
            <FlopHeatmap />
          </div>
        )}
        {tab === 'gameplan' && (
          <div className="content-col">
            <Gameplan />
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
        {tab === 'mathdrill' && (
          <div className="content-col">
            <MathDrill />
          </div>
        )}
        {tab === 'review' && (
          <div className="content-col">
            <Review />
          </div>
        )}
        {tab === 'sizing' && (
          <div className="content-col">
            <BetSizingDrill />
          </div>
        )}
        {tab === 'bankroll' && (
          <div className="content-col">
            <BankrollSim g={g} />
          </div>
        )}
        {tab === 'mental' && (
          <div className="content-col">
            <MentalGame />
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
        {tab === 'settings' && (
          <div className="content-col">
            <Settings g={g} />
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
