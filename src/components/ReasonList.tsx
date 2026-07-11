import { GlossaryText } from './CalcTip';

// Renders a reasoning string as a lead line + bullet points for readability.
// Bullets are marked in the source string with " • " (space-dot-space): the
// first segment is the lead, the rest become <li>s. With no marker it falls back
// to plain inline text. Every segment runs through GlossaryText so glossary
// terms stay hoverable. Callers must place this inside a block element (div),
// never a <p> — a <ul> inside a <p> is invalid and the browser will unwrap it.
export function ReasonList({ text }: { text: string }) {
  const parts = text.split(' • ').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return <GlossaryText text={text} />;
  const [lead, ...items] = parts;
  return (
    <>
      <GlossaryText text={lead} />
      <ul className="reason-list">
        {items.map((b, i) => (
          <li key={i}>
            <GlossaryText text={b} />
          </li>
        ))}
      </ul>
    </>
  );
}
