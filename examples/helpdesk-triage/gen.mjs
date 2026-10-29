// Helpdesk triage family: team rules are shown once across three training tasks, and the third one
// AMENDS a rule from the first. Held-out tasks attach no policy at all and are graded on post-amendment rules.
//   node gen.mjs train|held|oracle > file.json
let s = 1
const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = a => a[Math.floor(rnd() * a.length)]
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

export const POLICY = `# Helpdesk triage policy

Every ticket gets a severity and a routing team. These rules apply to every batch the helpdesk triages.

## Routing team (first matching rule wins)

1. The summary mentions phishing, a credential, or something suspicious -> \`sec\`
2. The requester's email ends in \`@contractor.example\` -> \`vendor\`
3. The summary mentions wifi, DNS, a firewall or the network -> \`net\`
4. The summary mentions a dashboard, a report, an ETL job or the database -> \`data\`
5. Anything else -> \`app\`

## Severity

- \`P1\`: \`users_affected\` is 50 or more, or the ticket is routed to \`sec\`.
- \`P2\`: \`users_affected\` is 5 or more, or the summary contains the word "blocked".
- \`P3\`: everything else.
`
export const UPDATE = `# Triage policy update -- effective 2026-10-01

This amends the helpdesk triage policy. Rules not mentioned here are unchanged.

1. Contractor tickets (\`@contractor.example\`) now route to \`desk\`. The \`vendor\` team no longer exists.
2. VPN problems are network problems: a summary that mentions VPN routes to \`net\`.
3. The \`P1\` threshold is lowered: \`users_affected\` of 30 or more is \`P1\`.
`
export const SPEC = `# Daily triage summary -- output standard

The ops channel ingests the first line of every triage report automatically. It must be exactly

    TRIAGE <batch date> P1=<n> P2=<n> P3=<n> SEC=<n>

where each \`P\` field counts the tickets with that severity and \`SEC\` counts the tickets routed to
\`sec\`. No markdown, no extra fields. Example: \`TRIAGE 2026-05-02 P1=1 P2=4 P3=3 SEC=1\`.
Anything after the first line is free text for humans.
`

const POOLS = {
  sec: ['Suspicious email asking staff to confirm credentials', 'Phishing link flagged by finance', 'Possible credential leak on the shared drive', 'Suspicious login prompt on the intranet'],
  net: ['Wifi drops every few minutes on floor 3', 'DNS lookups failing for internal sites', 'Firewall rejects the build server', 'Network printer unreachable from the annex'],
  vpn: ['VPN client fails to connect from home', 'VPN disconnects during video calls'],
  data: ['Sales dashboard shows yesterday numbers', 'ETL job for invoices failed overnight', 'Monthly report export is empty', 'Database query times out in the CRM'],
  app: ['Expense app crashes on submit', 'Calendar invites are not sending', 'Login page loads slowly', 'Mobile app shows a blank screen'],
}
const people = ['ana', 'bo', 'chen', 'dara', 'eli', 'fay', 'gus', 'hana', 'ivo', 'jun', 'kai', 'lea']

function route(t, v) {
  const x = t.summary.toLowerCase()
  if (/phishing|credential|suspicious/.test(x)) return 'sec'
  if (t.requester.endsWith('@contractor.example')) return v === 2 ? 'desk' : 'vendor'
  if (/wifi|dns|firewall|network/.test(x) || (v === 2 && /vpn/.test(x))) return 'net'
  if (/dashboard|report|etl|database/.test(x)) return 'data'
  return 'app'
}
function sev(t, team, v) {
  if (t.users_affected >= (v === 2 ? 30 : 50) || team === 'sec') return 'P1'
  if (t.users_affected >= 5 || /\bblocked\b/i.test(t.summary)) return 'P2'
  return 'P3'
}
// Every batch covers each rule the amendment changes, so a harness that kept the old rules fails.
function batch(prefix, n) {
  const kinds = ['sec', 'contractor', 'vpn', 'mid', 'blocked', 'data', 'app', 'net']
  while (kinds.length < n) kinds.push(pick(['data', 'app', 'net', 'sec', 'blocked']))
  const out = kinds.slice(0, n).map((k, i) => {
    const contractor = k === 'contractor' || (k !== 'sec' && rnd() < 0.1)
    const pool = k === 'contractor' ? pick(['app', 'data']) : k === 'mid' ? pick(['app', 'data', 'net']) : k === 'blocked' ? pick(['app', 'data']) : k
    let summary = pick(POOLS[pool])
    if (k === 'blocked') summary += ' - team blocked'
    const users = k === 'mid' ? int(30, 49) : k === 'blocked' ? int(1, 3) : pick([int(1, 4), int(5, 25), int(1, 4), int(50, 120)])
    return { id: `${prefix}${String(i + 1).padStart(2, '0')}`, requester: `${pick(people)}@${contractor ? 'contractor' : 'corp'}.example`, users_affected: users, summary }
  })
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] }
  return out
}
const csv = (ts, withLabels, v) =>
  (withLabels ? 'id,requester,users_affected,summary,sev,team\n' : 'id,requester,users_affected,summary\n') +
  ts.map(t => { const team = route(t, v); return [t.id, t.requester, t.users_affected, `"${t.summary}"`, ...(withLabels ? [sev(t, team, v), team] : [])].join(',') }).join('\n') + '\n'
const lineRe = (t, v) => { const team = route(t, v); return `(?=[\\s\\S]*^[-*\\s\`]*${t.id}\\s+${sev(t, team, v)}\\s+${team}[\`\\s]*$)` }
function summary(ts, date, v) {
  const c = { P1: 0, P2: 0, P3: 0, SEC: 0 }
  for (const t of ts) { const team = route(t, v); c[sev(t, team, v)]++; if (team === 'sec') c.SEC++ }
  return `^TRIAGE ${date} P1=${c.P1} P2=${c.P2} P3=${c.P3} SEC=${c.SEC}$`
}
const LINE = "One line per ticket in the form `<id> <severity> <team>` (e.g. `X01 P2 app`), nothing else on those lines."

function triageTask(id, prefix, date, v, docs) {
  const ts = batch(prefix, 8)
  return { id, domain: 'helpdesk', prompt: `Triage the ${date} ticket batch in tickets.csv following the team triage policy. ${LINE}`, sources: { 'tickets.csv': csv(ts, false, v), ...docs }, expect: { pattern: `^${ts.map(t => lineRe(t, v)).join('')}` } }
}
function summaryTask(id, prefix, date, v, docs) {
  const ts = batch(prefix, 8)
  return { id, domain: 'helpdesk', prompt: `Severity and team are already assigned in tickets.csv. Give the standard daily triage summary for the ${date} batch.`, sources: { 'tickets.csv': csv(ts, true, v), ...docs }, expect: { pattern: summary(ts, date, v) } }
}
function bothTask(id, prefix, date, v, docs) {
  const ts = batch(prefix, 8)
  return { id, domain: 'helpdesk', prompt: `Triage the ${date} ticket batch in tickets.csv following the team triage policy, then give the standard daily triage summary.`, sources: { 'tickets.csv': csv(ts, false, v), ...docs }, expect: { pattern: summary(ts, date, v) } }
}

const WORK = { work: 'A helpdesk analyst triages batches of IT support tickets -- severity and routing team for each -- and reports them in the formats the operations team ingests, following the team policies.', domainWord: 'helpdesk area', deliverableWord: 'triage report' }
const which = process.argv[2]
let tasks
if (which === 'train') {
  s = 9001
  const t1 = triageTask('helpdesk/train-policy', 'A', '2026-09-14', 1, { 'TRIAGE-POLICY.md': POLICY })
  t1.prompt = `Triage the 2026-09-14 ticket batch in tickets.csv following TRIAGE-POLICY.md. ${LINE}`
  const t2 = summaryTask('helpdesk/train-format', 'B', '2026-09-28', 1, { 'OUTPUT-SPEC.md': SPEC })
  t2.prompt = 'Severity and team are already assigned in tickets.csv. Give the daily triage summary for the 2026-09-28 batch as OUTPUT-SPEC.md describes.'
  const t3 = triageTask('helpdesk/train-update', 'C', '2026-10-12', 2, { 'POLICY-UPDATE-2026-10.md': UPDATE })
  t3.prompt = `Triage the 2026-10-12 ticket batch in tickets.csv following the team triage policy as amended by POLICY-UPDATE-2026-10.md. ${LINE}`
  tasks = [t1, t2, t3]
} else {
  s = 31337
  const docs = which === 'oracle' ? { 'TRIAGE-POLICY.md': POLICY, 'POLICY-UPDATE-2026-10.md': UPDATE, 'OUTPUT-SPEC.md': SPEC } : {}
  tasks = [
    triageTask('helpdesk/triage-1', 'N', '2026-11-03', 2, docs),
    triageTask('helpdesk/triage-2', 'P', '2026-11-10', 2, docs),
    summaryTask('helpdesk/summary-1', 'Q', '2026-11-17', 2, docs),
    summaryTask('helpdesk/summary-2', 'R', '2026-11-24', 2, docs),
    bothTask('helpdesk/both-1', 'S', '2026-12-01', 2, docs),
    bothTask('helpdesk/both-2', 'U', '2026-12-08', 2, docs),
  ]
}
console.log(JSON.stringify({ work: WORK, tasks }, null, 2))
