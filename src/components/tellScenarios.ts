// Tells quiz bank + view builder for TellsTrainer (split out so the component file
// exports only components — fast refresh).

// Question type: is the player being asked to name the READ, or pick the EXPLOIT?
export type QType = 'read' | 'exploit';
export type Category = 'Timing' | 'Physical' | 'Sizing' | 'Story' | 'Image' | 'Cluster';

// A single quiz scenario. `correctIndex` points into `options` as authored; the
// component shuffles option order at runtime and remaps, so the exported data
// stays stable (and unit-testable) while the on-screen answer position varies.
export interface TellScenario {
  id: string;
  category: Category;
  type: QType;
  prompt: string;
  options: string[];
  correctIndex: number;
  explain: string;
}

// All scenarios are grounded in Reference.tsx (§ "Reading people") + ai/decide.ts.
// Exported so TellsTrainer.test.ts can assert data integrity.
export const TELL_SCENARIOS: TellScenario[] = [
  // ---- Timing tells (the clock leaks more than the face) ----
  {
    id: 'timing-instant-bet',
    category: 'Timing',
    type: 'read',
    prompt:
      'A thinking reg fires an INSTANT pot-sized c-bet on the flop — no pause at all. What is the most likely read?',
    options: [
      'A pre-planned, automatic bet — usually a routine c-bet or a draw, not a cooler.',
      'A slow-rolled monster he decided to trap with.',
      'Genuine deep thought about value and sizing.',
    ],
    correctIndex: 0,
    explain:
      'An instant bet is automatic and pre-planned — it points to a routine c-bet or a draw, not a hand he agonized over. Real value with a sizing decision usually takes a beat.',
  },
  {
    id: 'timing-tank-bet',
    category: 'Timing',
    type: 'read',
    prompt: 'Villain goes into a long tank, then finally bets big on the river. Lean which way?',
    options: [
      'Weak — a long think before a bet is almost always Hollywooding a bluff.',
      'Strong — the tank was real thought about value and sizing.',
      'It is a pure coin flip; timing carries no information.',
    ],
    correctIndex: 1,
    explain:
      'A long tank before a bet is usually genuine thought about value and sizing, so lean strong. Real Hollywooding — faking a think on a bluff — is rare; believe tank-then-bet.',
  },
  {
    id: 'timing-snap-call',
    category: 'Timing',
    type: 'read',
    prompt: 'You bet the turn and villain snap-calls instantly. What does the snap-call tell you?',
    options: [
      'He has the nuts and is trapping.',
      'He is drawing dead and just gave up.',
      'His range is capped — a draw or medium hand, rarely a monster.',
    ],
    correctIndex: 2,
    explain:
      'A snap-call is capped: he would tank with the nuts (deciding whether to raise) and fold trash, so an instant call is a draw or a medium hand. Keep barreling.',
  },
  {
    id: 'timing-snap-call-exploit',
    category: 'Timing',
    type: 'exploit',
    prompt:
      'The turn snap-call capped villain at draws / medium hands. The river bricks the draw. Best exploit?',
    options: [
      'Barrel again — his capped, draw-heavy range just missed and has to fold.',
      'Check-fold; a snap-call means he is committed to calling down.',
      'Check to induce a bluff from the monster he is slow-playing.',
    ],
    correctIndex: 0,
    explain:
      'The snap-call caps him at draws and medium hands; when the draw bricks, a second barrel prints because that range cannot continue. The read sets up the exploit.',
  },
  {
    id: 'timing-instant-check',
    category: 'Timing',
    type: 'exploit',
    prompt: 'Villain instantly checks to you on the turn. Best exploit?',
    options: [
      'Check back; a snap-check is an obvious trap.',
      'Bet — an instant check is usually a give-up with no hand and no plan. Steal it.',
      'Give a free card; the snap-check induced you to bet into strength.',
    ],
    correctIndex: 1,
    explain:
      'An instant check almost always means he gave up — no hand, no plan. It is a prime spot to steal with a bet.',
  },
  {
    id: 'timing-announced-raise',
    category: 'Timing',
    type: 'read',
    prompt: "Villain says 'give me a second…', tanks, and then RAISES. What is the read?",
    options: [
      'He is clearly bluffing — the announced hesitation signals weakness.',
      'He mis-clicked, so the raise size is meaningless.',
      'Fake hesitation before strength — the pause was theatre. Respect the raise.',
    ],
    correctIndex: 2,
    explain:
      'Announced hesitation followed by a raise is staged — the theatrical pause is meant to look weak right before a strong hand. Respect it.',
  },

  // ---- Physical tells (Caro: strong means weak, weak means strong) ----
  {
    id: 'physical-trembling',
    category: 'Physical',
    type: 'read',
    prompt: "Live: after shoving the river, villain's hands are visibly trembling. Caro's read?",
    options: [
      'Nerves from bluffing — he is scared and on air.',
      'Adrenaline from a monster — genuine shaking after a big bet means believe the hand.',
      'Just cold hands; it means nothing.',
    ],
    correctIndex: 1,
    explain:
      'Trembling after a big bet is an adrenaline release from a made hand, not fear — a classic strong-means-weak reversal. Believe the shake.',
  },
  {
    id: 'physical-freeze',
    category: 'Physical',
    type: 'read',
    prompt:
      'After firing a big bet, villain goes completely still — statue-like, holding his breath. Likely?',
    options: [
      'On air — bluffers freeze to avoid leaking; value bettors stay loose.',
      'A monster — total stillness signals total confidence.',
      'Bored and about to muck.',
    ],
    correctIndex: 0,
    explain:
      'Bluffers go rigid and hold their breath to avoid giving anything away — the statue who just fired is often on air. Value bettors stay relaxed.',
  },
  {
    id: 'physical-theatrical',
    category: 'Physical',
    type: 'read',
    prompt:
      'One player stares you down and puffs up after betting; another is relaxed and chatty. Who is more likely WEAK?',
    options: [
      'The relaxed, chatty one — comfort means he has given up.',
      'Both are equally likely; the act is random noise.',
      'The theatrical, strong-acting one — the show is meant to scare you off the pot.',
    ],
    correctIndex: 2,
    explain:
      "Caro's rule: strong means weak. The theatrical player wants a fold (bluff); the relaxed 'don't care' player is often loaded. Believe the opposite of the show.",
  },
  {
    id: 'physical-recheck-cards',
    category: 'Physical',
    type: 'read',
    prompt: 'On a two-tone flop, villain re-checks his hole cards, then bets. Most likely?',
    options: [
      'He is confirming a made flush and value-betting.',
      'He is checking a suit for a flush draw — he does not have it yet.',
      'He forgot his cards; there is no information here.',
    ],
    correctIndex: 1,
    explain:
      'Re-checking after a flop usually means verifying a suit for a flush DRAW — he is on the draw, not holding a made hand yet.',
  },

  // ---- Sizing signature / the modeled fish sizing tell (ai/decide.ts) ----
  {
    id: 'sizing-fish-to-strength',
    category: 'Sizing',
    type: 'read',
    prompt:
      'A recreational player bets tiny (~⅓ pot) on some hands and near pot-sized on others. Across showdowns, the big bets keep being big hands. Read?',
    options: [
      'The size is random noise; ignore it entirely.',
      'Big bets are his bluffs; small bets are value traps.',
      'He sizes his bet by how good his hand looks — big bet = big hand, small stab = weak / probe.',
    ],
    correctIndex: 2,
    explain:
      "Low-stakes fish size by hand strength: monsters go big, weak/air goes small ('scared money'). It is readable and exploitable — the easy bots here model exactly this tell.",
  },
  {
    id: 'sizing-fish-exploit',
    category: 'Sizing',
    type: 'exploit',
    prompt:
      'You have confirmed this fish bets big with big hands, small with weak ones. He fires a tiny ⅓-pot stab into you. Best exploit?',
    options: [
      'Treat it as weak — float or raise, since the small size caps him at probes and air.',
      'Fold; a bet is a bet and he has shown big hands before.',
      'Call now, then give up on every later street no matter what.',
    ],
    correctIndex: 0,
    explain:
      'His small size IS the tell — a weak/probe range. Against a strength-sized bettor, attack the small bets and fold to the big ones.',
  },
  {
    id: 'sizing-deviation',
    category: 'Sizing',
    type: 'read',
    prompt:
      'A reg who always c-bets ⅓ pot suddenly jams 1.5× pot on the turn this hand. What matters most?',
    options: [
      'The absolute size — a 1.5× overbet is always a bluff.',
      'The deviation from his normal size — the sudden jump is the tell, not the raw number.',
      'Nothing; everybody overbets sometimes.',
    ],
    correctIndex: 1,
    explain:
      "Read the sizing signature by the DEVIATION, not the absolute number. Learn his normal size first, then a sudden jump — or a tiny 'please-call' bet — is the real signal.",
  },
  {
    id: 'sizing-random-raiser',
    category: 'Sizing',
    type: 'exploit',
    prompt:
      'A recreational player who clearly does not follow poker raises random sizes — sometimes pot, sometimes a wild overbet, no logic. How do you play it?',
    options: [
      'Fold more to his overbets — the big size means the nuts.',
      'Ignore the size and play the range: value big, never bluff, bluff-catch wide.',
      'Semi-bluff-raise back — big sizes are always draws you can rep over.',
    ],
    correctIndex: 1,
    explain:
      'Against a random / spewy raiser, big ≠ strong — the number carries zero information (same wide, uncapped, air-heavy range). Ignore the size; value big and never bluff (no fold equity).',
  },

  // ---- Story consistency ----
  {
    id: 'story-bet-bet-check',
    category: 'Story',
    type: 'read',
    prompt: 'Villain bets the flop, bets the turn, then CHECKS the river. What does the line usually represent?',
    options: [
      'A slow-play — the river check screams monster.',
      'A busted flush he will fold to any bet.',
      'Giving up or pot-controlling one pair — bet-bet-check is rarely a trap.',
    ],
    correctIndex: 2,
    explain:
      'Bet-bet-check is a give-up or thin pot-control line far more often than a trap. A real monster keeps betting or check-raises — the story of a passive river check does not fit strength.',
  },
  {
    id: 'story-passive-minraise',
    category: 'Story',
    type: 'read',
    prompt: 'A passive, rarely-raising player suddenly min-raises on a dry board. Read?',
    options: [
      'A made hand — a reluctant limp or min-raise from a passive player means strength. Slow down.',
      'A bluff — min-raises are always weak, so re-raise him.',
      'A blocker bet angling for a cheap showdown.',
    ],
    correctIndex: 0,
    explain:
      'When a passive player who never raises suddenly does — especially a min-raise on a dry board — it is a made hand. Respect the deviation from their baseline and slow down.',
  },

  // ---- Table image & leveling ----
  {
    id: 'image-tight',
    category: 'Image',
    type: 'exploit',
    prompt:
      'You have folded for an orbit and shown down only premiums — the table sees you as a rock. How should you adjust?',
    options: [
      'Bluff more — a tight image means your bets get respect and fold equity is high.',
      'Value-bet thinner — they will happily pay off your rock image.',
      'Play identically; your image does not change what works.',
    ],
    correctIndex: 0,
    explain:
      'Play to the image you have GIVEN them. A tight image earns respect, so bluffs get through — fire more. A loose / spewy image is the reverse: value more, bluff less.',
  },
  {
    id: 'leveling-level0',
    category: 'Image',
    type: 'exploit',
    prompt:
      "Your opponent is a level-0 station who only thinks 'what do I have?' and calls everything. Best plan?",
    options: [
      'Beat him with value — bet big and often, and never bluff.',
      'Bluff him relentlessly — he cannot stand pressure.',
      'Run multi-street bluffs; a good story will fold him out.',
    ],
    correctIndex: 0,
    explain:
      'A level-0 player only sees his own cards, so deception is wasted — beat him with a better hand and value. Play one level above your opponent: save bluffs for a level-2 who can fold.',
  },

  // ---- The meta-lesson: a cluster beats any single tell ----
  {
    id: 'cluster-single-tell',
    category: 'Cluster',
    type: 'read',
    prompt:
      'You spot ONE possible tell — villain glanced at his chips after the flop. He is a solid TAG you have no other reads on. How much should this drive your decision?',
    options: [
      'Fully — commit your stack; a chip glance is a lock that he is strong.',
      'Barely — a single tell on one hand is noise; the real signal is a CLUSTER of tells plus a deviation from his baseline.',
      'Invert it — one tell always means the exact opposite, so play him for weakness.',
    ],
    correctIndex: 1,
    explain:
      'One tell on one hand is noise. The read that pays is a cluster of tells plus a deviation from the player’s baseline: categorize the archetype first, read the betting story second, and treat a lone physical tell as a tie-breaker — never the whole decision.',
  },
];

// A concrete, display-ready scenario: options shuffled, answer remapped. Built
// with an rng so we never call Math.random during render (React forbids it there).
export interface ScenarioView {
  scenario: TellScenario;
  options: string[];
  answer: number; // index into the shuffled `options`
}

export function buildView(s: TellScenario, rng: () => number): ScenarioView {
  const order = s.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return {
    scenario: s,
    options: order.map((i) => s.options[i]),
    answer: order.indexOf(s.correctIndex),
  };
}

// Pick a random scenario (optionally not the current one) and build its view.
export function pickView(rng: () => number, avoidId?: string): ScenarioView {
  const pool = avoidId ? TELL_SCENARIOS.filter((s) => s.id !== avoidId) : TELL_SCENARIOS;
  const s = pool[Math.floor(rng() * pool.length)];
  return buildView(s, rng);
}
