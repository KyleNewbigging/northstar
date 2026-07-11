export function Ring({ value }: { value: number }) {
  const size = 36
  const stroke = 3
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const color = value > 0.8 ? 'var(--ok)' : value > 0.6 ? 'var(--star)' : 'var(--err)'
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={18} cy={18} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={stroke} />
      <circle cx={18} cy={18} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={c * (1 - value)} strokeLinecap="round" />
    </svg>
  )
}
