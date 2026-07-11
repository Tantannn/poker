import { useState, useEffect, lazy, Suspense } from 'react';
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
const SpotDebugger = lazy(() => import('./components/SpotDebugger').then((m) => ({ default: m.SpotDebugger })));
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

type Tab = 'learn' | 'play' | 'tournament' | 'charts' | 'trainer' | 'lab' | 'debug' | 'gameplan' | 'quiz' | 'exploit' | 'replay' | 'principles' | 'odds' | 'eqdrill' | 'mathdrill' | 'review' | 'sizing' | 'bankroll' | 'mental' | 'heatmap' | 'analytics' | 'reference' | 'settings';

// Remember the last-opened section across reloads. `poker-` prefix keeps it in
// the backup filter (backup.ts) so it travels with an export/import.
const TAB_KEY = 'poker-ui-tab';

const TABS: { id: Tab; label: string }[] = [
  { id: 'learn', label: '1. 🎓 Learning Path' },
  { id: 'play', label: '2. ♠ Play vs Bots' },
  { id: 'tournament', label: '3. 🏆 Tournament' },
  { id: 'charts', label: '4. Preflop Charts' },
  { id: 'trainer', label: '5. Range Trainer' },
  { id: 'lab', label: '6. Postflop Lab' },
  { id: 'debug', label: '7. 🧪 Custom Spot' },
  { id: 'heatmap', label: '8. 🔥 Flop Heatmap' },
  { id: 'gameplan', label: '9. 📋 Gameplan' },
  { id: 'quiz', label: '10. Leak Quiz' },
  { id: 'exploit', label: '11. 🎯 Read & Exploit' },
  { id: 'replay', label: '12. 🌟 Hand Review' },
  { id: 'principles', label: '13. 📓 Principles' },
  { id: 'odds', label: '14. Pot Odds' },
  { id: 'eqdrill', label: '15. 🧠 Equity Drill' },
  { id: 'mathdrill', label: '16. 🧮 Math Trainer' },
  { id: 'review', label: '17. 🔁 Review' },
  { id: 'sizing', label: '18. 💰 Bet Sizing' },
  { id: 'bankroll', label: '19. 💵 Bankroll' },
  { id: 'mental', label: '20. 🧘 Mental Game' },
  { id: 'analytics', label: '21. Analytics' },
  { id: 'reference', label: '22. Reference' },
  { id: 'settings', label: '23. ⚙ Settings' },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

function loadTab(fallback: Tab): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved && TAB_IDS.has(saved)) return saved as Tab;
  } catch {
    /* storage blocked — fall through to default */
  }
  return fallback;
}

export default function App() {
  const g = useGame(DEFAULT_PROFILES);
  // Restore the last-opened tab; if none saved, land on whichever session was
  // last live (cash vs tournament).
  const [tab, setTab] = useState<Tab>(() => loadTab(g.mode === 'tourney' ? 'tournament' : 'play'));
  // Panel visibility persists across reloads (same as study/think-first).
  const [hudEnabled, setHudEnabled] = useState(() => {
    try { return localStorage.getItem('poker.hud') !== '0'; } catch { return true; }
  });
  const toggleHud = () => {
    const next = !hudEnabled;
    setHudEnabled(next);
    try { localStorage.setItem('poker.hud', next ? '1' : '0'); } catch { /* ignore */ }
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');

  // The Play and Tournament tabs are the two persisted game sessions; entering
  // one swaps the live table to its slot (other tabs leave the session as-is).
  const selectTab = (t: Tab) => {
    if (t === 'play') g.setActiveMode('cash');
    else if (t === 'tournament') g.setActiveMode('tourney');
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage blocked — session is still consistent, just not persisted */
    }
    setMenuOpen(false);
    setQuery('');
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setQuery('');
  };

  // A restored Play/Tournament tab must also swap the live table to that mode
  // (setActiveMode no-ops when already matching). Runs once on mount.
  useEffect(() => {
    if (tab === 'play') g.setActiveMode('cash');
    else if (tab === 'tournament') g.setActiveMode('tourney');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the section menu on Escape, like a native dropdown.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const currentLabel = TABS.find((t) => t.id === tab)?.label ?? 'Menu';

  // Filter sections by the search box (case-insensitive substring on the label).
  const q = query.trim().toLowerCase();
  const filtered = q ? TABS.filter((t) => t.label.toLowerCase().includes(q)) : TABS;

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
        <button
          className="nav-toggle"
          aria-expanded={menuOpen}
          aria-haspopup="true"
          aria-label="Open section menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="nav-toggle-bars" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="nav-toggle-label">{currentLabel}</span>
        </button>
        {menuOpen && (
          <>
            <div className="nav-backdrop" onClick={closeMenu} />
            <div className="nav-menu" role="tablist" aria-label="Trainer sections">
              <input
                className="nav-search"
                type="search"
                autoFocus
                placeholder="Search sections…"
                aria-label="Search sections"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filtered[0]) selectTab(filtered[0].id);
                }}
              />
              {filtered.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)}>
                  {t.label}
                </button>
              ))}
              {filtered.length === 0 && <div className="nav-empty">No sections match “{query}”.</div>}
            </div>
          </>
        )}
      </nav>

      <main className="app-main">
       <Suspense fallback={<div className="card"><p className="sub">Loading…</p></div>}>
        {tab === 'learn' && (
          <div className="content-col">
            <Curriculum onGo={(t) => selectTab(t as Tab)} />
          </div>
        )}
        {(tab === 'play' || tab === 'tournament') && (
          <PokerTable g={g} hudEnabled={hudEnabled} onToggleHud={toggleHud} />
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
        {tab === 'debug' && (
          <div className="content-col">
            <SpotDebugger />
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
