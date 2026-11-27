import type { ActionRecord } from '@/engine/table';

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
const STREET_NAME: Record<string, string> = {
  preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River',
};

function describeAct(type: string, amount: number): string {
  switch (type) {
    case 'fold': return 'folds';
    case 'check': return 'checks';
    case 'call': return `calls ${amount}`;
    case 'bet': return `bets ${amount}`;
    case 'raise': return `raises to ${amount}`;
    case 'post': return `posts ${amount}`;
    default: return type;
  }
}

export function ActionLine({ actions }: { actions: ActionRecord[] }) {
  const byStreet = STREETS
    .map((street) => ({ street, acts: actions.filter((a) => a.street === street) }))
    .filter((g) => g.acts.length > 0);
  if (byStreet.length === 0) return null;

  return (
    <div className="dr-actions">
      {byStreet.map(({ street, acts }) => {
        const nWay = new Set(acts.map((a) => a.playerId)).size;
        return (
          <div className="dr-str" key={street}>
            <div className="dr-str-h">
              {STREET_NAME[street] ?? street}
              {street !== 'preflop' && <span className="dr-nway">{nWay}-way</span>}
            </div>
            <div className="dr-acts">
              {acts.map((a, i) => (
                <span className={`dr-act ${a.playerId === 0 ? 'you' : ''} ${a.type}`} key={i}>
                  <b>{a.playerId === 0 ? 'You' : a.position}</b> {describeAct(a.type, a.amount)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
