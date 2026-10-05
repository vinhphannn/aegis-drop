export default function ItemTime({ createdAt }: { createdAt: number }) {
  const date = new Date(createdAt);
  return <time className="item-time" dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} · {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
}
