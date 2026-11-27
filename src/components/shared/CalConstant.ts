import type { CalcCard, CalcId } from "./CalcTip";

/** Single source of truth for every formula's explanation + memory hook. */
export const CALC: Record<CalcId, CalcCard> = {
  equity: {
    title: 'Equity vs range',
    what: "Your share of the pot if all chips went in now, against every hand villain can hold.",
    formula: 'equity = win% + ½ × tie%',
    remember: 'It already blends ties in — never add them on top. From a Monte-Carlo run, not a guess.',
  },
  winTie: {
    title: 'Win / Tie %',
    what: 'How often you win outright vs chop, simulated over many random run-outs.',
    formula: 'equity = win% + ½ × tie%',
    remember: 'A tie only returns half the pot, so it counts half.',
  },
  potOdds: {
    title: 'Equity needed to call',
    what: 'The slice of the final pot your call has to win to break even.',
    formula: 'need = call ÷ (pot + call)',
    remember: 'By size: ⅓-pot→20%, ½→25%, ¾→30%, pot→33%, 2×→40%. Call when your equity ≥ this.',
  },
  oddsRatio: {
    title: 'Pot odds (ratio)',
    what: 'What you stand to win versus what you risk.',
    formula: 'ratio = pot : call   →   equity need = call ÷ (pot + call)',
    remember: '2:1 means risk 1 to win 2 = need 33%. Flip ratio to % with call ÷ (pot+call).',
  },
  ev: {
    title: 'EV (expected value)',
    what: 'Average chips a line wins or loses if you played it many times, in big blinds.',
    formula: 'EV = Σ (outcome × its probability)',
    remember: 'Pick the highest-EV line. +EV = profitable long run; the sign matters more than the size.',
  },
  evLoss: {
    title: 'EV loss',
    what: 'How many bb your move gave up versus the highest-EV line available.',
    formula: 'EV loss = bestEV − yourEV',
    remember: '0 = optimal. The honest skill metric — a tiny loss is noise, a big one is a real leak.',
  },
  outs: {
    title: 'Outs',
    what: 'Unseen cards that improve you to a likely-best hand.',
    formula: 'flush draw = 9, OESD = 8, gutshot = 4, two overs = 6',
    remember: "Count cards that actually win — discount outs that also pair the board for villain.",
  },
  ruleOf24: {
    title: 'Rule of 2 & 4',
    what: 'Turn outs into rough equity-to-improve without a calculator.',
    formula: 'flop (2 to come) ≈ outs × 4   ·   turn (1 to come) ≈ outs × 2',
    remember: 'With 9+ outs on the flop, shave ~1–2% — the ×4 slightly over-counts.',
  },
  potGeometry: {
    title: 'Bet geometry',
    what: 'Equity a caller needs vs a bet of f× pot — and the bluff % the bettor needs at that size.',
    formula: 'both = f ÷ (1 + 2f)',
    remember: 'One number, two jobs: equity-to-call = bluffs-needed. Memorize one column.',
  },
  mdf: {
    title: 'MDF (min defense frequency)',
    what: "How often you must continue so a bettor can't auto-profit by always bluffing.",
    formula: 'MDF = pot ÷ (pot + bet) = 1 ÷ (1 + f)',
    remember: 'Bet bigger → defend less. Pot-bet → defend 50%; ½-pot → defend 67%.',
  },
  riverBalance: {
    title: 'River value : bluff',
    what: 'How a polar river bet mixes value and bluffs so villain’s calls break even.',
    formula: 'bluff% = f ÷ (1 + 2f)   ·   ratio = (1 − bluff%) : bluff%',
    remember: 'Pot-bet → 2:1 value-to-bluff; bigger bets allow more bluffs.',
  },
  bb100: {
    title: 'Win rate (bb/100)',
    what: 'Big blinds won per 100 hands — the standard win-rate unit.',
    formula: '(net bb ÷ hands) × 100',
    remember: '+5 to +10 bb/100 is a strong winner; it normalizes for sample size.',
  },
  evLoss100: {
    title: 'EV lost / 100',
    what: 'Big blinds bled per 100 hands from sub-optimal decisions.',
    formula: '(total EV lost ÷ hands) × 100',
    remember: 'Lower is better — this is leakage, not variance. Under ~0.5 bb/100 is sharp.',
  },
  gtowScore: {
    title: 'GTOW score',
    what: 'Weighted grade of every move, 0–100.',
    formula: 'best 100 · correct 90 · inaccuracy 55 · wrong 25 · blunder 0, averaged',
    remember: 'One blunder sinks more than several inaccuracies — points drop fast down the tiers.',
  },
  accuracy: {
    title: 'Decision accuracy',
    what: 'Share of moves that matched the baseline (charts preflop, equity-vs-pot-odds postflop).',
    formula: 'correct ÷ total moves',
    remember: "A yardstick, not a solver — close spots show as 'reasonable', not wrong.",
  },
  rngAdherence: {
    title: 'RNG adherence',
    what: 'In mixed spots a random roll prescribes which action to take.',
    formula: 'followed ÷ mixed-strategy spots',
    remember: 'Only mixed spots count. Following the roll keeps your overall frequencies balanced.',
  },
  netBB: {
    title: 'Net result',
    what: 'Cumulative big blinds won or lost this session.',
    formula: 'Σ each hand’s bb result',
    remember: 'Short-run = mostly variance. Judge skill by EV loss, not by net.',
  },
  spr: {
    title: 'SPR (stack-to-pot ratio)',
    what: 'Effective stack divided by the pot — sets how committed you are.',
    formula: 'SPR = effective stack ÷ pot',
    remember: 'Low (<3) → stack off top-pair+. High (>6) → need a much stronger hand to commit.',
  },
  betEvFormula: {
    title: 'How this number is worked out',
    what: 'A bet can win two ways: everyone folds and you take the pot now, OR someone calls and you win the showdown often enough to come out ahead. This adds up both.',
    formula: 'value = (chance all fold × pot)\n      + (chance you get called × your share of the bigger pot − chips you put in)',
    remember: 'Checking just wins your equity slice of today’s pot. A bet is better only when the two chances above add up to more than that. Pick the bigger number.',
  },
};

/** Plain-language glossary: poker jargon that shows up in the generated
 *  feedback text. `GlossaryText` scans a note/detail string and underlines any
 *  of these terms with a hover card — so a beginner never hits a word with no
 *  explanation. `terms` lists every spelling/variant that maps to one card. */
export const GLOSSARY: { terms: string[]; card: CalcCard }[] = [
  {
    terms: ['fair share'],
    card: {
      title: 'Fair share',
      what: "In a multiway pot, an even slice of the equity: 1 ÷ number of players. Clearing this bar means you win more than an even split — you're ahead of the pack (even if the whole field combined still beats you most of the time).",
      formula: 'fair share = 1 ÷ players   (4-way → 25%, 3-way → 33%)',
      remember: 'Above it = best slice at the table. Below it = genuinely behind. Heads-up the bar is 50%.',
    },
  },
  {
    terms: ['worst hand that still calls', 'worst hand that calls'],
    card: {
      title: 'Size to the worst hand that calls',
      what: 'Value-bet sizing rule: pick the biggest size a WORSE hand will still pay off with. You bet FOR the hands you beat — not the ones that beat you.',
      formula: 'too big → only better hands call (you get value-owned)\ntoo small → you leave money behind',
      remember: 'If the only hands that call are ones that beat you, your bet is too big.',
    },
  },
  {
    terms: ['customers'],
    card: {
      title: 'Customers',
      what: 'The worse hands that pay off your value bet. "Oversizing folds out your customers" means betting so big the weak hands you wanted to call just fold instead.',
      remember: 'No customers, no value. Size so the hands you beat can still call.',
    },
  },
  {
    terms: ['bluff-catcher', 'bluff catcher'],
    card: {
      title: 'Bluff-catcher',
      what: "A medium hand that beats only bluffs and loses to value. It can't bet for value (worse hands fold, better hands call) — its job is to CHECK and CALL, catching the bluffs.",
      remember: "Don't bet a bluff-catcher. Keep the pot small and pay off the right amount.",
    },
  },
  {
    terms: ['out of position'],
    card: {
      title: 'Out of position (OOP)',
      what: 'You act first on every street, so you give away info and realize less of your equity — villain can bet you off hands. Lean toward checking and smaller bets.',
      remember: "Act first on a street = OOP = you realize less. 'First to act' means you're OOP.",
    },
  },
  {
    terms: ['in position'],
    card: {
      title: 'In position (IP)',
      what: 'You act last on every street, so you see what villain does first and realize MORE of your equity — you can take free cards and control the pot.',
      remember: 'Act last = IP = you realize more. Position is worth money.',
    },
  },
];
