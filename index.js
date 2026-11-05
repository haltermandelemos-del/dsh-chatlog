// dsh-chatlog v0.3.0 —— 把每个会话导出成本地纯文本文档
//
// 规则只有一条：
//   还活着的会话     → <dir>/<标题>-<会话号>.txt
//   归档的、已消失的 → <dir>/<归档子目录>/<标题>-<会话号>.txt
//
// “活着” = 磁盘上还有会话文件，或本进程正在跟踪它（首轮还没落盘）。
// “归档” = ~/.dsh/storages/workspace.json 的 global.archivedSessionIds 里
//          有它（DSH 界面上的“删除会话”其实就是归档，文件原地不动）。
//
// 几条不写在注释里就会被人改坏的约定：
//   1. 只碰“自己写的”文件 —— 文件头里有 `会话  session-...` 那行才算自己的，
//      别人的 .txt 一律不读不写不删不改名。
//   2. 临时文件名固定带 `.chatlog-<pid>.<tag>.tmp` 尾巴，清理时只认这个形状，
//      不会把用户自己的 `备份.2024.10.15` 当成垃圾删掉。
//   3. 目标文件名总是带 8 位会话号，天然不撞车，不需要任何“占用检测”。
//   4. 归档集合读不到就一率不搬文件；会话目录读不到就不判“已消失”。
//      两个方向都选“不动”，宁可少搬一次，也不能把整柜文档搬错地方。
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'chatlog'

const VERSION = '0.3.0'
const SESSION_ROOT = path.join(homedir(), '.dsh', 'sessions')
const WORKSPACE_STATE = path.join(homedir(), '.dsh', 'storages', 'workspace.json')
const DEFAULT_DIR = '/sdcard/dsh/DshChat'
const DEFAULT_ARCHIVE = 'DeletedChat'
const STATE_FILE = '.chatlog-state.json'
const ZSTD_MAGIC = 0xfd2fb528
/** 进程内最多缓存几个会话的完整记录。 */
const MAX_SESSIONS = 8
/** 只认自己写的临时文件，绝不误伤用户文件。 */
const TMP_TAIL = /\.chatlog-\d+\.[0-9a-z]+\.tmp$/
const TMP_TTL_MS = 6 * 60 * 60 * 1000
/** 文件头里记录归属的那一行。 */
const OWNER_RE = /^会话[ \t]+(session-\S+)[ \t]*$/m

/* ================================================================== *
 * zstd 多帧解码
 *
 * DSH 的会话文件是几十个 zstd 帧首尾相接（每落盘一批追加一帧）。
 * 整个文件喂给 zstdDecompressSync 只能解出第一帧，所以得自己走帧头。
 * ================================================================== */
function zstdDecode(buf) {
  let out = ''
  let off = 0
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === ZSTD_MAGIC) {
    const start = off
    off += 4
    if (off >= buf.length) break
    const d = buf.readUInt8(off)
    off += 1
    const fcsFlag = d >>> 6
    const singleSegment = (d & 0x20) !== 0
    const hasChecksum = (d & 0x04) !== 0
    const dictFlag = d & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag
    off += (singleSegment ? 0 : 1) + dictBytes + fcsBytes
    let done = false
    while (off + 3 <= buf.length) {
      const bh = buf.readUIntLE(off, 3)
      off += 3
      const last = bh & 1
      const type = (bh >>> 1) & 0x03
      const size = bh >>> 3
      if (type === 3) { done = true; break }          // 保留块 = 帧结束
      off += type === 1 ? 1 : size                    // RLE 块只有 1 字节
      if (last) break
    }
    if (!done && hasChecksum) off += 4
    if (off > buf.length) break
    try {
      out += zstdDecompressSync(buf.subarray(start, off)).toString('utf8')
    } catch {
      break           // 尾部残帧：已经解出来的部分照样能用
    }
  }
  return out
}

/** 读一个会话文件的全部记录。读不了就返回空数组。 */
function readRecords(file) {
  try {
    const buf = fs.readFileSync(file)
    const text = file.endsWith('.zstd') ? zstdDecode(buf) : buf.toString('utf8')
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* 半行就跳过 */ }
    }
    return out
  } catch {
    return []
  }
}

/** 扫描所有会话文件：id -> { file, mtimeMs }。目录读不到返回 null。 */
function scanSessions() {
  let projects
  try {
    projects = fs.readdirSync(SESSION_ROOT)
  } catch {
    return null
  }
  const out = new Map()
  for (const proj of projects) {
    let names
    try { names = fs.readdirSync(path.join(SESSION_ROOT, proj)) } catch { continue }
    for (const n of names) {
      if (!n.startsWith('session-')) continue
      const dir = path.join(SESSION_ROOT, proj, n)
      for (const f of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const p = path.join(dir, f)
        let st
        try { st = fs.statSync(p) } catch { continue }
        if (!st.isFile()) continue
        out.set(n, { file: p, mtimeMs: st.mtimeMs })
        break
      }
    }
  }
  return out
}

/* ================================================================== *
 * 文本渲染
 * ================================================================== */
const FMT_MAX = 8
const fmtCache = new Map()

function fmtTime(ms, tz) {
  if (!Number.isFinite(ms)) return '?'
  let f = fmtCache.get(tz)
  if (!f) {
    const opt = {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }
    try { f = new Intl.DateTimeFormat('en-CA', { ...opt, timeZone: tz }) } catch {
      f = new Intl.DateTimeFormat('en-CA', opt)
    }
    if (fmtCache.size >= FMT_MAX) fmtCache.clear()
    fmtCache.set(tz, f)
  }
  const p = {}
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value
  return p.year + '/' + p.month + '/' + p.day + ' ' +
    (p.hour === '24' ? '00' : p.hour) + ':' + p.minute + ':' + p.second
}

/** 把 Markdown 标记清成纯文本（保留内容，只去标记）。 */
function cleanText(s) {
  return String(s)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (m, body) => body.replace(/\s+$/, ''))
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
}

/** 把任意段落文字收成正常换行，去掉首尾空行。 */
function tidy(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')
}

/** 正文清洗：按配置决定要不要去 Markdown 标记。 */
function body_(s, opt) {
  const t = tidy(s)
  return opt.clean === false ? t : tidy(cleanText(t))
}

/** 取消息 content 数组里的正文；非文本部分用方括号占位，不静默丢弃。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const p of content) {
    if (!p || typeof p !== 'object') continue
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text)
    else if (p.type === 'reasoning') continue          // 由调用方决定要不要
    else if (p.type === 'image') {
      const a = p.attachment || {}
      out.push('[图片 ' + [a.mediaType, a.width && a.height ? a.width + '×' + a.height : '']
        .filter(Boolean).join(' ') + ']')
    } else if (p.type === 'tool-call') continue
    else if (p.name) out.push('[' + p.type + ' ' + p.name + ']')
    else out.push('[' + (p.type || '未知内容') + ']')
  }
  return out.join('\n')
}

function reasoningText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(p => p && p.type === 'reasoning' && typeof p.text === 'string')
    .map(p => p.text).join('\n')
}

function clip(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim()
  return [...one].length > n ? [...one].slice(0, n).join('') + '…' : one
}

/** 会话文件短号：8 位，够区分，也够短。 */
function shortOf(id) {
  return String(id).replace(/^session-/, '').slice(0, 8)
}

/** 标题 → 安全文件名主干。去掉首尾的点和空格（避免生成隐藏文件）。 */
function baseName(title, id) {
  let b = String(title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[. \t]+/g, ' ')
    .trim()
  if (!b) b = '会话'
  if ([...b].length > 40) b = [...b].slice(0, 40).join('').trim()
  return b + '-' + shortOf(id)
}

/** 标题取最后一条 session/title。 */
function titleOf(records) {
  let t = ''
  for (const r of records) if (r.type === 'session/title' && r.data && r.data.title) t = r.data.title
  return t
}

/** 整个文档的正文。records 按 seq 排好序。 */
function render(id, records, opt) {
  const head = records.find(r => r.type === 'session') || {}
  const L = []
  L.push('DSH 对话记录')
  L.push('标题  ' + (titleOf(records) || '（无标题）'))
  L.push('会话  ' + id)
  if (head.cwd) L.push('目录  ' + head.cwd)
  L.push('开始  ' + fmtTime(head.createdAt, opt.tz))
  L.push('导出  ' + fmtTime(Date.now(), opt.tz))
  L.push('时区  ' + opt.tz)

  const body = []
  let lastBlock = ''       // 'user' | 'assistant' | 'tool'
  let lastTurn = null
  const callNames = new Map()

  const openBlock = (kind, time, force) => {
    if (!force && lastBlock === kind) return
    body.push('')
    body.push('—— ' + fmtTime(time, opt.tz) + ' · ' + kind + ' ——')
    lastBlock = kind
  }

  for (const r of records) {
    const d = r.data || {}
    if (r.type === 'user/message') {
      const kind = d.source && d.source.kind
      if (kind && kind !== 'user') continue        // 注入的上下文不算对话
      const text = body_(contentText(d.content), opt)
      if (!text) continue
      openBlock('你', r.time, false)
      body.push(text)
      lastTurn = null
    } else if (r.type === 'assistant/message') {
      const content = (d.message && d.message.content) || d.content
      if (opt.showReasoning) {
        const rt = body_(reasoningText(content), opt)
        if (rt) { openBlock('思考', r.time, false); body.push(rt) }
      }
      const text = body_(contentText(content), opt)
      if (text) { openBlock('助手', r.time, false); body.push(text) }
      lastBlock = ''
    } else if (r.type === 'tool/call') {
      if (!opt.showTools) continue
      callNames.set(d.callId, d.name)
      if (lastTurn !== d.turn || lastBlock !== '工具') {
        openBlock('工具', r.time, true)
      }
      lastTurn = d.turn
      body.push('→ ' + (d.name || '工具') + ' ' + clip(d.arguments || '{}', 160))
    } else if (r.type === 'tool/result') {
      if (!opt.showTools) continue
      const name = callNames.get(d.toolCallId) || '结果'
      let text = body_(contentText(d.content || (d.message && d.message.content)), opt)
      const rows = text ? text.split('\n') : []
      const limit = Math.max(1, Number(opt.maxResultLines) || 6)
      if (rows.length > limit) {
        text = rows.slice(0, limit).join('\n') + '\n…（还有 ' + (rows.length - limit) + ' 行）'
      }
      if (lastBlock !== '工具') { openBlock('工具', r.time, true); lastTurn = d.turn }
      body.push('← ' + name + (d.isError ? '（失败）' : '') + (text ? '' : '（无输出）'))
      if (text) for (const line of text.split('\n')) body.push('  ' + line)
    }
  }

  if (!body.length) body.push('', '（这次会话还没有可导出的对话内容）')
  return L.join('\n') + '\n' + body.join('\n').replace(/\n+$/, '') + '\n'
}

/* ================================================================== *
 * 插件主体
 * ================================================================== */
export async function apply(ctx, config) {
  const cfg = Object.assign({
    enabled: true,
    dir: DEFAULT_DIR,
    archiveSubdir: DEFAULT_ARCHIVE,
    tz: 'Asia/Shanghai',
    showTools: true,
    showReasoning: false,
    maxResultLines: 6,
    clean: true,
    syncMs: 60000,          // 后台同步间隔；0 = 只在启动和每轮结束时同步
    skipSubagents: true,
  }, config || {})

  const warnings = new Set()
  const warn = (msg) => {
    if (warnings.has(msg)) return
    warnings.add(msg)
    try { ctx.logger?.warn?.('chatlog: ' + msg) } catch { /* 忽略 */ }
  }
  if (typeof cfg.dir !== 'string' || !path.isAbsolute(cfg.dir)) {
    warn('dir 配置无效（' + cfg.dir + '），已回退 ' + DEFAULT_DIR)
    cfg.dir = DEFAULT_DIR
  }
  const ARCHIVE_DIR = path.join(cfg.dir, String(cfg.archiveSubdir || DEFAULT_ARCHIVE))

  /** id -> { recs: Map<seq|'h', record>, seen: number } */
  const store = new Map()
  /** id -> 上一次写出的文件路径（标题/目录变化时删旧文件用） */
  const currentFile = new Map()
  const stats = { written: 0, moved: 0, errors: 0, lastPath: '', lastError: '', lastAt: '' }
  const loadedAt = new Date().toISOString()

  /* ---------- 落盘小工具 ---------- */
  let tmpSeq = 0
  const tmpTag = () => process.pid + '.' + Date.now().toString(36) + (++tmpSeq).toString(36)

  function writeAtomic(target, text) {
    const tmp = target + '.chatlog-' + tmpTag() + '.tmp'
    try {
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, target)
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch { /* 没写出来就不用删 */ }
      throw err
    }
  }

  /** 读文件头里的归属会话号；不是本插件的文件返回 null。 */
  function ownerOf(file) {
    let fd
    try {
      fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(2048)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const head = buf.subarray(0, n).toString('utf8')
      const m = OWNER_RE.exec(head)
      return m ? m[1] : null
    } catch {
      return null
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 忽略 */ } }
    }
  }

  function listDocs() {
    const out = new Map()      // id -> [{ file, dir, mtimeMs }]，新的在前
    for (const dir of [cfg.dir, ARCHIVE_DIR]) {
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.txt')) continue
        const f = path.join(dir, n)
        let st
        try { st = fs.statSync(f) } catch { continue }
        if (!st.isFile()) continue
        const id = ownerOf(f)
        if (!id) continue                     // 不是我们的文件，永远不碰
        const list = out.get(id) || []
        list.push({ file: f, dir, mtimeMs: st.mtimeMs })
        out.set(id, list)
      }
    }
    for (const list of out.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out
  }

  /**
   * 给会话挑一个不撞车的文件名：从 8 位短号逐级加长。
   * 撞车的定义是“文件已存在且不是这个会话的”——包括用户手写的同名文件。
   */
  function uniquePath(dir, id, title) {
    const bare = String(id).replace(/^session-/, '')
    const stem = baseName(title, id).replace(/-[0-9a-f]{8}$/i, '')
    for (const n of [8, 12, 16, 24, 32]) {
      const f = path.join(dir, stem + '-' + bare.slice(0, n) + '.txt')
      if (!fs.existsSync(f)) return f
      if (ownerOf(f) === id) return f
    }
    return path.join(dir, stem + '-' + bare + '-' + Date.now().toString(36) + '.txt')
  }

  function cleanupTmp() {
    const now = Date.now()
    for (const dir of [cfg.dir, ARCHIVE_DIR]) {
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (!TMP_TAIL.test(n)) continue       // 只认自己的临时文件
        const f = path.join(dir, n)
        try {
          if (now - fs.statSync(f).mtimeMs > TMP_TTL_MS) fs.unlinkSync(f)
        } catch { /* 删不掉就算了 */ }
      }
    }
  }

  /* ---------- 归属判断 ---------- */
  function archivedIds() {
    try {
      const j = JSON.parse(fs.readFileSync(WORKSPACE_STATE, 'utf8'))
      const ids = j && j.global && j.global.archivedSessionIds
      if (!Array.isArray(ids)) return new Set()
      return new Set(ids.map(String))
    } catch {
      return null          // 读不到：整轮不搬文件
    }
  }

  function snapshot() {
    const arch = archivedIds()
    const files = scanSessions()
    const alive = new Set(files ? files.keys() : [])
    // 只有“本轮真的收到过事件”的会话才算活着：首轮还没落盘时文件不在，
    // 但它确实是活的；反过来，只是被从磁盘读进内存的旧会话不算。
    for (const [id, e] of store) if (e.live) alive.add(id)
    return { arch, archKnown: !!arch, files, filesKnown: !!files, alive }
  }

  /** 该不该进归档目录：被归档，或者会话文件已经不在了。 */
  function isDead(id, snap) {
    if (snap.archKnown && snap.arch.has(id)) return true
    if (snap.filesKnown && !snap.alive.has(id)) return true
    return false
  }

  /**
   * 文档该放哪儿。
   *   - 归档 / 会话已消失  → 归档目录
   *   - 其余               → 根目录
   * 但归档集合读不到时，不敢断定“它没有归档”，所以已经在归档目录里的
   * 一律原地不动 —— 少搬一次也比把归档文档搬回来强。
   */
  function dirFor(id, snap, docDir) {
    if (isDead(id, snap)) return ARCHIVE_DIR
    const inArchive = docDir && path.resolve(docDir) === path.resolve(ARCHIVE_DIR)
    if (!inArchive) return cfg.dir
    // 已经在归档里、但按当前快照又“不算死” —— 只有同时拿到归档集合和会话
    // 文件清单、并且确认它确实还活着，才敢把它搬回根目录。看不见就不动。
    return snap.archKnown && snap.filesKnown && snap.alive.has(id) ? cfg.dir : ARCHIVE_DIR
  }

  /* ---------- 记录缓存 ---------- */
  let snapCache = { at: 0, snap: null }
  function recentSnapshot() {
    if (snapCache.snap && Date.now() - snapCache.at < 2000) return snapCache.snap
    const snap = snapshot()
    snapCache = { at: Date.now(), snap }
    return snap
  }

  function entryFor(id) {
    let e = store.get(id)
    if (e) { e.seen = Date.now(); return e }
    e = { recs: new Map(), seen: Date.now(), live: false }
    store.set(id, e)
    // resume 的种子不会再发 session/event，历史只能从磁盘回填一次
    const files = scanSessions()
    const hit = files && files.get(id)
    if (hit) for (const r of readRecords(hit.file)) e.recs.set(r.seq === undefined ? 'h' : r.seq, r)
    return e
  }

  function trimStore(keepId) {
    if (store.size <= MAX_SESSIONS) return
    const victims = [...store.entries()].filter(([id]) => id !== keepId)
      .sort((a, b) => (a[1].seen || 0) - (b[1].seen || 0))
    while (store.size > MAX_SESSIONS && victims.length) store.delete(victims.shift()[0])
  }

  const sorted = (e) => [...e.recs.values()].sort((a, b) => {
    const x = typeof a.seq === 'number' ? a.seq : -1
    const y = typeof b.seq === 'number' ? b.seq : -1
    return x - y
  })

  /* ---------- 写一个会话 ---------- */
  function exportSession(id, snap) {
    try {
      if (!cfg.enabled) return null
      const e = store.get(id)
      if (!e || !e.recs.size) return null
      const records = sorted(e)
      const text = render(id, records, cfg)
      const docs = listDocs()
      const dir = dirFor(id, snap, docs.has(id) ? docs.get(id)[0].dir : null)
      const target = uniquePath(dir, id, titleOf(records))
      fs.mkdirSync(dir, { recursive: true })
      writeAtomic(target, text)

      // 一个会话只留一份文档：标题变了、换了目录、或历史遗留的副本都删掉
      const stale = [...(docs.get(id) || []).map(d => d.file)]
      const prev = currentFile.get(id)
      if (prev) stale.push(prev)
      for (const f of stale) {
        if (!f || path.resolve(f) === path.resolve(target)) continue
        try { if (ownerOf(f) === id) fs.unlinkSync(f) } catch { /* 已经不在就算了 */ }
      }
      currentFile.set(id, target)
      snapCache = { at: 0, snap: null }
      stats.written += 1
      stats.lastPath = target
      stats.lastAt = new Date().toISOString()
      stats.lastError = ''
      return target
    } catch (err) {
      stats.errors += 1
      stats.lastError = String(err && err.message ? err.message : err)
      warn('导出失败 ' + stats.lastError)
      return null
    }
  }

  /* ---------- 对账：搬文件 + 补导出 ---------- */
  function relocateAll(snap) {
    if (!snap.archKnown && !snap.filesKnown) return   // 两眼一抹黑，一个都不搬
    const docs = listDocs()
    for (const [id, list] of docs) {
      const want = dirFor(id, snap, list[0].dir)
      for (const doc of list) {
        if (path.resolve(want) === path.resolve(doc.dir)) continue
        const dest = path.join(want, path.basename(doc.file))
        try {
          fs.mkdirSync(want, { recursive: true })
          if (fs.existsSync(dest)) {
            if (ownerOf(dest) !== id) continue      // 目标被别人的文件占着，留着不动
            fs.unlinkSync(dest)                     // 自己的旧副本，覆盖
          }
          try {
            fs.renameSync(doc.file, dest)
          } catch {
            fs.copyFileSync(doc.file, dest)
            if (ownerOf(doc.file) === id) fs.unlinkSync(doc.file)
          }
          if (currentFile.get(id) === doc.file) currentFile.set(id, dest)
          stats.moved += 1
        } catch (err) {
          warn('搬移失败 ' + path.basename(doc.file) + '：' + String(err && err.message))
        }
      }
    }
  }

  let syncing = false
  async function syncAll(force) {
    if (syncing) return
    syncing = true
    try {
      cleanupTmp()
      const snap = snapshot()
      relocateAll(snap)
      const docs = listDocs()
      const files = snap.files || new Map()
      // 会话文件比文档新（或还没文档）→ 补导出；分段让出事件循环，别卡住对话
      for (const [id, f] of files) {
        const doc = docs.get(id) && docs.get(id)[0]
        if (doc && doc.mtimeMs >= f.mtimeMs) continue
        if (!store.has(id)) {
          const recs = readRecords(f.file)
          const head = recs.find(r => r.type === 'session')
          if (cfg.skipSubagents && head && ((typeof head.delegationDepth === 'number' && head.delegationDepth > 0) || head.parentSessionId)) continue
          const e = { recs: new Map(), seen: Date.now(), live: false }
          for (const r of recs) e.recs.set(r.seq === undefined ? 'h' : r.seq, r)
          store.set(id, e)
          trimStore(id)
        }
        exportSession(id, snap)
        // eslint-disable-next-line no-await-in-loop
        if (force) await new Promise(r => setImmediate(r))
      }
    } catch (err) {
      warn('同步失败：' + String(err && err.message))
    } finally {
      syncing = false
      writeState()
    }
  }

  /* ---------- 状态文件 ---------- */
  function writeState() {
    try {
      fs.mkdirSync(cfg.dir, { recursive: true })
      const body = {
        plugin: 'dsh-chatlog',
        version: VERSION,
        rule: '活着 → ' + cfg.dir + '；归档/已消失 → ' + ARCHIVE_DIR,
        loadedAt,
        updatedAt: new Date().toISOString(),
        enabled: cfg.enabled,
        written: stats.written,
        moved: stats.moved,
        errors: stats.errors,
        lastPath: stats.lastPath,
        lastError: stats.lastError,
        lastAt: stats.lastAt,
        sessionsInMemory: store.size,
        warnings: [...warnings],
      }
      writeAtomic(path.join(cfg.dir, STATE_FILE), JSON.stringify(body, null, 2) + '\n')
    } catch { /* 状态文件写不了不影响导出 */ }
  }

  /* ---------- 钩子 ---------- */
  const isSubagent = (session, event) => {
    const h = (session && session.header) || {}
    const d = typeof h.delegationDepth === 'number' ? h.delegationDepth
      : (event && typeof event.delegationDepth === 'number' ? event.delegationDepth : null)
    if (d !== null && d > 0) return true
    return Boolean(h.parentSessionId || (h.parent && h.parent.id))
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      if (cfg.skipSubagents && isSubagent(session, event)) return
      const e = entryFor(session.id)
      e.live = true
      e.recs.set(event.seq === undefined ? 'h' : event.seq, event)
      e.seen = Date.now()
      trimStore(session.id)
      if (event.type === 'turn/end') {
        // 归档/会话消失是不会发事件的，只能靠每轮结束顺手对一次账
        const snap = recentSnapshot()
        relocateAll(snap)
        exportSession(session.id, snap)
        writeState()
      }
    } catch (err) {
      warn('事件处理失败 ' + String(err && err.message))
    }
  })

  // 启动：先搬文件（快），再异步补导出（慢，不阻塞）
  queueMicrotask(() => { syncAll(true).catch(() => {}) })

  const tickMs = Number(cfg.syncMs)
  if (Number.isFinite(tickMs) && tickMs > 0) {
    const startTimer = () => {
      const timer = setInterval(() => { syncAll(false).catch(() => {}) }, tickMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }
    if (typeof ctx.effect === 'function') ctx.effect(startTimer, 'chatlog.sync')
    else startTimer()
  }

  try { ctx.logger?.info?.('chatlog: 已加载 v' + VERSION + ' → ' + cfg.dir + '（归档 → ' + ARCHIVE_DIR + '）') } catch { /* 忽略 */ }
}