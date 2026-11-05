// 冒烟测试：node test/smoke.mjs
// 用假的 ctx 与假会话目录跑一遍，验证「活着留在根目录 / 归档进 DeletedChat」的核心规则，
// 以及「不碰用户自己的文件」这条底线。全部通过时退出码为 0。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const RIG = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-smoke-'))
const HOME = path.join(RIG, 'home')
const OUT = path.join(RIG, 'DshChat')
const SESS = path.join(HOME, '.dsh', 'sessions', '--root--')
const WS = path.join(HOME, '.dsh', 'storages', 'workspace.json')
process.env.HOME = HOME

const A = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const B = 'session-bbbbbbbb-1111-2222-3333-444444444444'

function makeSession(id, title) {
  const dir = path.join(SESS, id)
  fs.mkdirSync(dir, { recursive: true })
  const recs = [
    { type: 'session', version: 4, id, createdAt: 1793407465859, cwd: '/root' },
    { type: 'session/title', seq: 0, time: 1793407515591, data: { title } },
    { type: 'user/message', seq: 1, time: 1793407515576, data: { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 2, time: 1793407520000, data: { turn: 1 } },
  ]
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n')
  return dir
}

const dirA = makeSession(A, '甲会话')
const dirB = makeSession(B, '乙会话')
fs.mkdirSync(path.dirname(WS), { recursive: true })
const setArch = ids => fs.writeFileSync(WS, JSON.stringify({ global: { archivedSessionIds: ids } }))
setArch([])

// 用户自己的文件，插件必须一个都不碰
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, '报告.txt'), '我自己的报告\n')
fs.writeFileSync(path.join(OUT, '备份.2024.10.15'), '我的备份\n')

const handlers = []
const ctx = {
  on: (name, fn) => { if (name === 'session/event') handlers.push(fn) },
  effect: fn => fn(),
  logger: { info() {}, warn: m => console.log('[warn]', m) },
}
const mod = await import('../index.js')
await mod.apply(ctx, { dir: OUT, tz: 'Asia/Shanghai', syncMs: 0 })
const wait = ms => new Promise(r => setTimeout(r, ms))
const ls = d => { try { return fs.readdirSync(d).sort() } catch { return [] } }
const txt = d => ls(d).filter(n => n.endsWith('.txt'))
const fire = (sessionId, event) => { for (const h of handlers) h({ id: sessionId, header: {} }, event) }
const turnEnd = (sessionId, seq) => fire(sessionId, { type: 'turn/end', seq, time: 1793407600000 + seq * 1000, data: { turn: seq } })

let failed = 0
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  ← ' + detail))
  if (!ok) failed += 1
}
const inRoot = id => txt(OUT).some(n => n.endsWith('-' + id.slice(8, 16) + '.txt'))
const inArchive = id => txt(path.join(OUT, 'DeletedChat')).some(n => n.endsWith('-' + id.slice(8, 16) + '.txt'))

await wait(400)
check('启动后两份文档都在根目录', inRoot(A) && inRoot(B), `root=${txt(OUT).join('|')}`)
check('用户文件「报告.txt」原样保留', fs.readFileSync(path.join(OUT, '报告.txt'), 'utf8') === '我自己的报告\n')
check('用户文件「备份.2024.10.15」原样保留', fs.existsSync(path.join(OUT, '备份.2024.10.15')))

setArch([A])
turnEnd(A, 3)
await wait(200)
check('归档后文档进 DeletedChat', inArchive(A) && !inRoot(A), `root=${txt(OUT).join('|')}`)
check('未归档的那份仍在根目录', inRoot(B))

setArch([])
turnEnd(A, 4)
await wait(200)
check('取消归档后搬回根目录', inRoot(A) && !inArchive(A), `root=${txt(OUT).join('|')}`)

fs.rmSync(dirB, { recursive: true, force: true })
turnEnd(A, 5)
await wait(200)
check('会话文件消失后文档进 DeletedChat', inArchive(B) && !inRoot(B))

const docA = path.join(OUT, txt(OUT).find(n => n.endsWith('-aaaaaaaa.txt')))
check('文档题头写了会话号', fs.readFileSync(docA, 'utf8').includes('会话  ' + A))
check('文档含对话正文', fs.readFileSync(docA, 'utf8').includes('第一句'))

fs.rmSync(path.join(OUT, '归档会话'), { recursive: true, force: true })
fs.rmSync(RIG, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过')
process.exit(failed ? 1 : 0)