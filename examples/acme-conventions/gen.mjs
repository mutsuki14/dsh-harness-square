// "Team conventions" family: knowledge that is shown once (in a training task's handbook) and needed later.
// Held-out tasks never include the handbook, so only a harness that carried it over can pass them.
let s = 1
const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = a => a[Math.floor(rnd() * a.length)]

export const DATA_MD = `# Acme analytics -- data conventions

These apply to every export the analytics team works with.

- \`amount\` in orders.csv is an integer number of US cents, never dollars. 129900 means $1,299.00.
- Customer ids that start with \`QA-\` are internal test accounts. Exclude their rows from every metric.
- Rows with \`kind\` = \`refund\` carry a positive amount and reduce net revenue.
- Sale rows with \`status\` = \`cancelled\` never count.
- Net revenue = counted sales minus counted refunds.
`
export const DASH_MD = `# Acme analytics -- dashboard conventions

The dashboard ingests the first line of every report automatically. It must be exactly

    KPI <CODE> <period> = <value>

with no markdown, no currency symbol and no thousands separator. Codes:

- \`NREV\`: net revenue in whole US dollars, rounded half up.
- \`ORDS\`: number of counted sale rows (refunds are not orders).

Example: \`KPI ORDS 2026-05 = 41\`. Anything after the first line is free text for humans.
`
function rows(period, { qa, cancelled, n }) {
  const [y, m] = period.split('-')
  const out = []
  let id = 1000 + Math.floor(rnd() * 8000)
  for (let i = 0; i < n; i++) {
    const kind = rnd() < 0.18 ? 'refund' : 'sale'
    const status = kind === 'sale' && cancelled && rnd() < 0.15 ? 'cancelled' : 'completed'
    const cust = qa && rnd() < 0.2 ? `QA-${Math.floor(rnd() * 90 + 10)}` : `C${Math.floor(rnd() * 900 + 100)}`
    const amount = Math.floor(rnd() * 60000) + 1500
    out.push({ order_id: `O${id++}`, date: `${y}-${m}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`, customer_id: cust, kind, status, amount })
  }
  return out
}
function truth(rs) {
  let cents = 0, ords = 0
  for (const r of rs) {
    if (r.customer_id.startsWith('QA-') || r.status === 'cancelled') continue
    if (r.kind === 'sale') { cents += r.amount; ords++ } else cents -= r.amount
  }
  return { cents, ords }
}
const csv = rs => 'order_id,date,customer_id,kind,status,amount\n' + rs.map(r => `${r.order_id},${r.date},${r.customer_id},${r.kind},${r.status},${r.amount}`).join('\n') + '\n'
// The calc prompt does not forbid "$" or thousands separators, so the checker accepts them: it grades the value only.
const money = c => { const [i, d] = (Math.abs(c) / 100).toFixed(2).split('.'); return `${c < 0 ? '\\-' : ''}\\$?${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',?')}\\.${d}` }
const dollars = c => String(c >= 0 ? Math.floor((c + 50) / 100) : -Math.floor((-c + 50) / 100)).replace('-', '\\-')

// kind: calc (needs data conventions), format (needs dashboard conventions), both.
function task(id, kind, period, withDocs) {
  const rs = rows(period, { qa: kind !== 'format', cancelled: kind !== 'format', n: 14 })
  const t = truth(rs)
  const sources = { 'orders.csv': csv(rs) }
  let prompt, pattern
  if (kind === 'calc') {
    prompt = `Compute net revenue for ${period} from orders.csv, following the team's data conventions. First line exactly 'Net revenue: <USD with two decimals>', then a one-line note.`
    pattern = `^Net revenue: ${money(t.cents)}$`
  } else if (kind === 'format') {
    prompt = `Report the ${period} order count from orders.csv for the dashboard, using the team's standard dashboard line.`
    pattern = `^KPI ORDS ${period} = ${t.ords}$`
  } else {
    prompt = `Report ${period} net revenue from orders.csv for the dashboard, following the team's data conventions and using the team's standard dashboard line.`
    pattern = `^KPI NREV ${period} = ${dollars(t.cents)}$`
  }
  if (withDocs === 'data' || withDocs === 'all') sources['HANDBOOK-data.md'] = DATA_MD
  if (withDocs === 'dash' || withDocs === 'all') sources['HANDBOOK-dashboard.md'] = DASH_MD
  return { id, domain: 'acme-analytics', prompt, sources, expect: { pattern } }
}
const WORK = { work: 'An analyst on the Acme analytics team turns raw order exports into the figures the team reports, following the team conventions.', domainWord: 'analytics area', deliverableWord: 'report' }
const which = process.argv[2]
let tasks
if (which === 'train') {
  s = 777
  tasks = [
    { ...task('acme/train-data', 'calc', '2026-08', 'data'), prompt: `Compute net revenue for 2026-08 from orders.csv, following HANDBOOK-data.md. First line exactly 'Net revenue: <USD with two decimals>', then a one-line note.` },
    { ...task('acme/train-dash', 'format', '2026-07', 'dash'), prompt: `Report the 2026-07 order count from orders.csv for the dashboard as HANDBOOK-dashboard.md describes.` },
  ]
} else {
  s = 4242
  const docs = which === 'oracle' ? 'all' : undefined
  const P = ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']
  tasks = [task('acme/calc-1', 'calc', P[0], docs), task('acme/calc-2', 'calc', P[1], docs), task('acme/format-1', 'format', P[2], docs), task('acme/format-2', 'format', P[3], docs), task('acme/both-1', 'both', P[4], docs), task('acme/both-2', 'both', P[5], docs)]
}
console.log(JSON.stringify({ work: WORK, tasks }, null, 2))
