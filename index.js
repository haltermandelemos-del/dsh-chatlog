// dsh-chatlog —— 每轮对话结束，自动把这次会话写成本地纯文本 .txt
//
// 设计要点，都是踩过或查证过的：
//
//   1. 只挂 session/event 一个钩子。DSH 自己的持久化层就是这么写的
//      （dsh-session-persistence-jsonl 的 install()），因为事件本身就是
//      要落盘的那条记录 —— 既有数据、也有时机：type === 'turn/end'
//      就是"这一轮答完了"。
//
//   2. 会话 resume 的种子**不会再发** session/event。dsh-session 的源码里
//      写得很明确："Seed events never publish on `session/event`"。
//      所以第一次见到某个会话时必须先从磁盘回填历史，否则插件装上之前
//      的对话会整段丢失。
//
//   3. 零第三方依赖：不 import schemastery，安装过程也就不需要联网。
//      这跟 dsh-phone 的选择一致 —— 插件在离线容器里装，多一个依赖就
//      多一个装不上的理由。
//
//   4. 落盘一律"写临时文件 + rename"原子替换，且临时文件名带 pid/时间戳
//      （自动导出与手动工具同时跑也不会互相踩）。
//
// 所有导出逻辑一律包在 try/catch 里：这是"顺手干的活"，
// 绝不能因为它出错而影响对话本身。写盘结果记在 <dir>/.chatlog-state.json，
// 出问题能直接看到，不用翻 DSH 日志。
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'chatlog'
export const inject = ['tools']

const VERSION = '0.1.8'
const SESSION_ROOT = path.join(homedir(), '.dsh', 'sessions')
const DEFAULT_DIR = '/sdcard/dsh/dsh会话'
/** 归档会话的子目录名（放在 dsh会话 里面）。 */
const ARCHIVE_SUBDIR = '归档会话'
/** 旧的导出目录：历史文档要从这里迁进新目录。 */
const LEGACY_DIR = '/sdcard/dsh/chatlog'
/** DSH 里的"删除会话"其实是归档：只往这个文件的全局集合里加一个 id，文件不动。 */
const WORKSPACE_STATE = path.join(homedir(), '.dsh', 'storages', 'workspace.json')
const ZSTD_MAGIC = 0xfd2fb528
/** 插件自己的运行状态，写在输出目录里。 */
const STATE_FILE = '.chatlog-state.json'
/** 进程内最多缓存几个会话的记录（超过就淘汰最久没动静的）。 */
const MAX_SESSIONS = 12
/** 崩溃残留的 .tmp 超过这个年龄才清，避免误删别的进程正在写的。 */
const TMP_TTL_MS = 6 * 60 * 60 * 1000
const DEPTHS = new Set(['plain', 'summary', 'full'])

/* ------------------------------------------------------------------ *
 * zstd 多帧容器解码
 *
 * DSH 的会话文件不是单个 zstd 流，而是几十个 zstd 帧首尾相接
 * （每落盘一批追加一帧）。直接把整个文件喂给 zstdDecompressSync
 * 只能解出第一帧，后面全部丢失 —— 所以必须自己按帧头结构走。
 * ------------------------------------------------------------------ */
function scanFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictFlag = descriptor & 3
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const csBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const rest = (singleSegment ? 0 : 1) + dictBytes + csBytes
    if (buf.length - offset < rest) return { frames, tornStart: start }
    offset += rest
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const bh = buf.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0
      const type = (bh >>> 1) & 3
      const size = bh >>> 3
      if (type === 3) return { frames, tornStart: start }
      const payload = type === 1 ? 1 : size
      if (buf.length - offset < payload) return { frames, tornStart: start }
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: undefined }
}

/** 解码一个会话文件，返回记录数组。写了一半的尾巴自动丢弃。 */
function decodeSessionFile(file) {
  const buf = fs.readFileSync(file)
  let text = ''
  if (file.endsWith('.zstd')) {
    for (const f of scanFrames(buf).frames) {
      try { text += zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { /* 坏帧跳过 */ }
    }
  } else {
    text = buf.toString('utf8')
  }
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* 半截行 */ }
  }
  return records
}

/* ------------------------------------------------------------------ *
 * 会话文件定位
 * ------------------------------------------------------------------ */
function candidateFiles() {
  const out = []
  let projects = []
  try { projects = fs.readdirSync(SESSION_ROOT) } catch { return out }
  for (const proj of projects) {
    const projDir = path.join(SESSION_ROOT, proj)
    let sessions = []
    try { sessions = fs.readdirSync(projDir) } catch { continue }
    for (const s of sessions) {
      if (!s.startsWith('session-')) continue
      const dir = path.join(projDir, s)
      for (const f of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const p = path.join(dir, f)
        try { if (fs.statSync(p).isFile()) { out.push({ id: s, file: p, mtime: fs.statSync(p).mtimeMs }); break } } catch { /* 下一个 */ }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 按会话 id 找落盘文件；找不到返回 null。 */
function findSessionFile(id) {
  return candidateFiles().find((c) => c.id === id) || null
}

/* ------------------------------------------------------------------ *
 * 渲染成纯文本
 * ------------------------------------------------------------------ */
/** 时区 -> formatter。原来是每条消息都 new 一个，长会话能建上千个。 */
const fmtCache = new Map()

function formatterFor(tz) {
  if (fmtCache.has(tz)) return fmtCache.get(tz)
  let f = null
  try {
    f = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
  } catch { f = null }
  fmtCache.set(tz, f)
  return f
}

function fmtTime(ms, tz) {
  if (!Number.isFinite(ms)) return '?'
  const f = formatterFor(tz)
  if (f) {
    try { return f.format(new Date(ms)) } catch { /* 落到下面的兜底 */ }
  }
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function partText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((p) => p && p.type === 'text').map((p) => p.text ?? '').join('')
}
function partReasoning(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((p) => p && p.type === 'reasoning').map((p) => p.text ?? '').join('')
}
/** 去掉注入进用户消息里的系统提示（AGENTS.md、运行时快照等）。 */
function cleanUserText(t) {
  let s = String(t ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  const i = s.indexOf('<system-reminder>')
  if (i !== -1) s = s.slice(0, i)
  return s.trim()
}
function describeToolArgs(raw) {
  let args = raw
  if (typeof raw === 'string') { try { args = JSON.parse(raw) } catch { return raw.slice(0, 160) } }
  if (!args || typeof args !== 'object') return String(raw ?? '').slice(0, 160)
  const keys = ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'text', 'task']
  const bits = []
  for (const k of keys) {
    if (args[k] === undefined) continue
    let v = Array.isArray(args[k]) ? args[k].join(' | ') : String(args[k])
    v = v.replace(/\s+/g, ' ').trim()
    if (v.length > 140) v = v.slice(0, 140) + ' …'
    bits.push(k + '=' + v)
    if (bits.length >= 2) break
  }
  if (!bits.length) bits.push(JSON.stringify(args).replace(/\s+/g, ' ').slice(0, 160))
  return bits.join('  ')
}

/**
 * 把记录数组渲染成纯文本。
 * @param {object[]} records - 会话记录（含 session 头和各类事件），按 seq 升序
 * @param {{depth:string, sessionId?:string}} opt - depth: plain | summary | full
 */
function render(records, opt) {
  const depth = opt.depth === 'full' ? 'full' : opt.depth === 'summary' ? 'summary' : 'plain'
  const head = records.find((r) => r.type === 'session') || {}
  const sessionId = head.id || opt.sessionId || '?'

  let tz = 'Asia/Shanghai'
  for (const r of records) {
    const z = (r && r.data && r.data.source && r.data.source.clientTimeZone) ||
      (r && r.data && r.data.inserted && r.data.inserted[0] && r.data.inserted[0].source && r.data.inserted[0].source.clientTimeZone)
    if (typeof z === 'string' && z) { tz = z; break }
  }

  let title = ''
  for (const r of records) if (r.type === 'session/title' && r.data && r.data.title) title = r.data.title

  // records 是按 seq 递增插入的（Map 保留插入顺序），不需要再排序。
  const ordered = records

  const out = []
  out.push('DSH 对话记录')
  out.push('标题  ' + (title || '(无标题)'))
  out.push('会话  ' + sessionId)
  out.push('目录  ' + (head.cwd ?? '?'))
  out.push('开始  ' + fmtTime(head.createdAt, tz))
  out.push('导出  ' + fmtTime(Date.now(), tz))
  out.push('时区  ' + tz)
  out.push('')

  let n = 0
  const pendingTools = new Map()

  for (const r of ordered) {
    const t = r.type
    const time = r.time

    if (t === 'user/message') {
      const d = r.data || {}
      const kind = d.source && d.source.kind
      const raw = partText(d.content || (d.message && d.message.content))
      // 只把真人输入当成"你"说的话。agent-instructions / runtime-context /
      // user-approval 都是系统注入，不是用户发言。
      // 但 kind 缺失的情况（老会话、别的入口）要当成用户发言 —— 否则真实
      // 的用户输入会被静默丢掉，那是不可逆的数据丢失。
      const isUser = kind === undefined || kind === null || kind === '' || kind === 'user'
      if (!isUser) {
        if (depth !== 'full') continue
        let note = cleanUserText(raw)
        if (opt.clean) note = plainText(note).replace(/\s+/g, ' ')
        if (!note) continue
        out.push('系统注入 ' + (kind || '未知'))
        out.push(note.replace(/\s+/g, ' ').slice(0, 200))
        out.push('')
        continue
      }
      let text = cleanUserText(raw)
      if (opt.clean) text = plainText(text)
      if (!text.trim()) continue
      n += 1
      out.push('你  ' + fmtTime(time, tz))
      out.push(text)
      out.push('')
      continue
    }

    if (t === 'assistant/message') {
      const msg = (r.data && r.data.message) || r.data
      let text = partText(msg && msg.content).trim()
      let think = partReasoning(msg && msg.content).trim()
      if (opt.clean) { text = plainText(text); think = plainText(think) }
      if (!text && !(depth === 'full' && think)) continue
      n += 1
      out.push('助手  ' + fmtTime(time, tz))
      if (depth === 'full' && think) { out.push('思考过程'); out.push(think); out.push('') }
      if (text) out.push(text)
      out.push('')
      continue
    }

    if (t === 'tool/call') {
      const nm = (r.data && r.data.name) || '?'
      const summary = describeToolArgs(r.data && r.data.arguments)
      const id = r.data && r.data.callId
      if (id && depth !== 'plain') pendingTools.set(id, '工具 ' + nm + '  ' + summary)
      if (depth === 'full') {
        out.push('工具调用 ' + nm + '  ' + fmtTime(time, tz))
        let a = r.data && r.data.arguments
        if (typeof a === 'string') { try { a = JSON.stringify(JSON.parse(a), null, 2) } catch { /* 原样 */ } }
        else a = JSON.stringify(a, null, 2)
        out.push(String(a))
        out.push('')
      }
      continue
    }

    if (t === 'tool/result') {
      const id = r.data && (r.data.toolCallId || (r.data.message && r.data.message.toolCallId))
      if (id && pendingTools.has(id)) {
        out.push(pendingTools.get(id))
        out.push('')
        pendingTools.delete(id)
      }
      if (depth === 'full') {
        const text = partText((r.data && r.data.message && r.data.message.content) || (r.data && r.data.content))
        out.push('工具输出' + (r.data && r.data.isError ? '（出错）' : ''))
        out.push(text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text)
        out.push('')
      }
      continue
    }
  }

  if (n === 0) out.push('（这次会话还没有对话内容）')
  return out.join('\n').replace(/\n+$/, '\n')
}

/* ------------------------------------------------------------------ *
 * Markdown → 纯文本
 *
 * 助手的回复本身就是 Markdown 原文。存成 .txt 时留着一堆 ## ** ` | ，读起来
 * 全是符号，所以默认做一遍"轻量清洗"：只处理确定是标记的东西，绝不重排，
 * 也绝不动代码 —— 代码块和行内代码先被识别出来，里面的 ** 和 # 原样保留。
 *
 * 关闭方式：配置 clean: false。
 * ------------------------------------------------------------------ */
/** 找行内代码的闭合反引号串；找不到返回 -1。 */
function findTickRun(s, from, n) {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== '`') continue
    let m = 0
    while (s[i + m] === '`') m++
    if (m === n) return i
    i += m - 1
  }
  return -1
}

/**
 * 把行内代码换成占位符（反引号一起去掉），内容存进 store 等清洗完再还原。
 * 必须占位：像 \`a**b**c\` 这种，如果只是脱掉反引号，后面的加粗规则就会
 * 把 a**b**c 吃成 abc —— 代码里的东西一个字符都不能变。
 */
function maskInlineCode(line, store) {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '`') { out += line[i]; i++; continue }
    let n = 0
    while (line[i + n] === '`') n++
    const close = findTickRun(line, i + n, n)
    if (close === -1) { out += line.slice(i, i + n); i += n; continue }
    store.push(line.slice(i + n, close))
    out += '\u0000' + (store.length - 1) + '\u0000'
    i = close + n
  }
  return out
}

/** 把占位符换回行内代码原文。 */
function unmaskInlineCode(line, store) {
  return line.replace(/\u0000(\d+)\u0000/g, (_m, k) => (store[Number(k)] ?? ''))
}

/** 行内标记：转义、图片、链接、加粗、删除线。斜体 *x* 故意不处理（会误伤 2*3*4）。 */
function stripInlineMarks(line) {
  let s = line
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1')
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt) => (alt.trim() ? '[图片: ' + alt.trim() + ']' : '[图片]'))
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, t, u) => (t.trim() === u ? u : t + '（' + u + '）'))
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1$2')
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
  return s
}

/** 表格的分隔行（|---|---|）。 */
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/

/**
 * 把一段 Markdown 正文变成纯文本。
 * 逐行处理：围栏代码块整段跳过（内容原样），其余行去标题井号、去引用 >、
 * 统一列表符、表格去竖线、分割线换成一整行破折号。
 */
function plainText(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n')
  const out = []
  let fence = ''
  for (const raw of src.split('\n')) {
    const line = raw.replace(/[ \t]+$/, '')
    const m = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (m && m[2][0] === fence[0] && !m[3].trim()) { fence = ''; out.push('————————'); continue }
      out.push(raw)            // 代码内容一个字都不动
      continue
    }
    if (m) { fence = m[2]; out.push('————————'); continue }

    const t = line.trim()
    if (!t) { out.push(''); continue }
    // 表格行：去掉首尾竖线，单元格之间两个空格；纯分隔行整行丢掉
    if (t.startsWith('|')) {
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      if (cells.length > 1 && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      const done = cells.map((c) => {
        const st = []
        return unmaskInlineCode(stripInlineMarks(maskInlineCode(c, st)), st)
      })
      out.push(done.join('  '))
      continue
    }
    // 分割线
    if (/^([-*_])(\s*\1){2,}$/.test(t)) { out.push('————————'); continue }
    // 标题：去掉 #，文字保留
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*$/)
    if (h) { const st = []; out.push(unmaskInlineCode(stripInlineMarks(maskInlineCode(h[2], st)), st)); continue }
    // 引用：去掉 > 前缀，保留缩进
    let l = line.replace(/^(\s*)(?:>\s?)+/, '$1')
    // 列表：* / + 统一成 -
    l = l.replace(/^(\s*)([-*+])\s+/, '$1- ')
    const st = []
    out.push(unmaskInlineCode(stripInlineMarks(maskInlineCode(l, st)), st))
  }
  return out.join('\n')
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */
export async function apply(ctx, config) {
  const cfg = Object.assign({
    enabled: true,
    dir: DEFAULT_DIR,
    depth: 'plain',          // plain | summary | full
    skipSubagents: true,
    clean: true,             // 把助手/用户正文里的 Markdown 标记清成纯文本
    tools: false,            // 是否注册 chatlog_export 手动导出工具（会占每次请求的 tool list）
  }, config || {})

  let defineTool = null
  let toolsError = ''

  const warnings = []
  if (!DEPTHS.has(cfg.depth)) { warnings.push('depth 配置无效（' + cfg.depth + '），已回退 plain'); cfg.depth = 'plain' }
  if (typeof cfg.dir !== 'string' || !path.isAbsolute(cfg.dir)) {
    warnings.push('dir 配置无效（' + cfg.dir + '），已回退 ' + DEFAULT_DIR)
    cfg.dir = DEFAULT_DIR
  }

  /** sessionId -> { records: Map<seq, record>, header, lastSeen } */
  const store = new Map()
  const stats = { written: 0, errors: 0, lastPath: '', lastError: '', lastWriteAt: '' }
  const recent = []          // 最近几条落盘记录，方便查"哪次会话写到哪了"
  let lastActiveId = null
  const loadedAt = new Date().toISOString()

  /** 输出目录里的一份运行状态，出问题时直接看它。 */
  function writeState() {
    try {
      fs.mkdirSync(cfg.dir, { recursive: true })
      const body = {
        plugin: 'dsh-chatlog',
        version: VERSION,
        hook: 'session/event (turn/end)',
        loadedAt,
        updatedAt: new Date().toISOString(),
        dir: cfg.dir,
        depth: cfg.depth,
        clean: cfg.clean !== false,
        enabled: cfg.enabled,
        skipSubagents: cfg.skipSubagents,
        tools: typeof defineTool === 'function' ? 'chatlog_export' : (cfg.tools ? '(on, 不可用' + (toolsError ? ': ' + toolsError : '') + ')' : '(off)'),
        written: stats.written,
        errors: stats.errors,
        lastWriteAt: stats.lastWriteAt,
        lastPath: stats.lastPath,
        lastError: stats.lastError,
        sessionsInMemory: store.size,
        recent,
        warnings,
      }
      const target = path.join(cfg.dir, STATE_FILE)
      const tmp = target + '.' + tmpTag()
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, target)
    } catch { /* 写不了状态文件不该让插件失效 */ }
  }

  // 插件一装好就把历史文档归位（旧目录迁移 + 归档分类）。放进微任务，
  // 因为 reconcile 要用的几个 const 还在下面才初始化。
  queueMicrotask(() => {
    try { reconcile(true) } catch { /* 对账失败绝不能挡住对话 */ }
    writeState()
  })

  function entryFor(session) {
    let e = store.get(session.id)
    if (e) return e
    e = { records: new Map(), header: null, lastSeen: Date.now() }
    store.set(session.id, e)
    // 回填：resume 的种子不会发 session/event，不读盘就丢历史。
    try {
      const found = findSessionFile(session.id)
      if (found) for (const r of decodeSessionFile(found.file)) e.records.set(r.seq, r)
    } catch { /* 回填失败不影响后续 */ }
    return e
  }

  /** 内存里的会话记录不能无限长；超过上限就丢最久没动静的那个。 */
  function trimStore(keepId) {
    if (store.size <= MAX_SESSIONS) return
    const victims = [...store.entries()]
      .filter(([id]) => id !== keepId)
      .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0))
    for (const [id] of victims) {
      if (store.size <= MAX_SESSIONS) break
      store.delete(id)
    }
  }

  /** sessionId -> 最近一次落盘的文件路径（标题会变，改名时得知道旧路径） */
  const currentFile = new Map()
  /** 文件名主干 -> 占用它的 sessionId（两个会话同名时靠它区分） */
  const fileOwner = new Map()

  const shortOf = (id) => String(id).replace(/^session-/, '').slice(0, 8)

  /** 每次写盘唯一的临时文件名：pid + 时间戳 + 序号，并发也不会撞。 */
  let tmpSeq = 0
  const tmpTag = () => process.pid + '.' + Date.now().toString(36) + '.' + (++tmpSeq).toString(36)

  /**
   * 读归档集合。
   *
   * DSH 界面上"删除会话"其实只是**归档**：往 workspace.json 的全局集合里加一个
   * 会话 id，会话文件和目录原地不动。所以插件判断该不该归档，也只能读这个集合。
   */
  function archivedIds() {
    try {
      const j = JSON.parse(fs.readFileSync(WORKSPACE_STATE, 'utf8'))
      const ids = j && j.global && j.global.archivedSessionIds
      return new Set(Array.isArray(ids) ? ids.map(String) : [])
    } catch {
      return null   // 读不到就返回 null：对账时整体跳过，绝不能把归档文档搬回去
    }
  }

  /**
   * 上次对账时的归档集合。对账只在集合**变了**或启动时跑一次 ——
   * 每轮都全目录对账既慢，又会把用户手工整理的文档搬回去。
   */
  const archState = { key: null, set: null }

  /** 会话该落在哪个目录：进了归档集合就进「归档会话」子目录。 */
  function dirFor(sessionId, arch) {
    return arch && arch.has(sessionId) ? path.join(cfg.dir, ARCHIVE_SUBDIR) : cfg.dir
  }

  /**
   * 取最后一个 session/title 的标题。
   *
   * 标题不是一开始就有的：首轮之后才由 fallback（截首句）生成，之后还可能被
   * 模型改写成更概括的名字。所以文件名必须在**每次写盘时重新算**，标题变了就改名。
   */
  function titleOf(records) {
    let t = ''
    for (const r of records) if (r.type === 'session/title' && r.data && r.data.title) t = r.data.title
    return t
  }

  /** 把会话标题变成安全的文件名主干（保留中文，只清掉非法字符）。 */
  function titleToBase(title, sessionId) {
    const short = shortOf(sessionId)
    let base = String(title || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
    if (!base) base = '会话-' + short
    if ([...base].length > 40) base = [...base].slice(0, 40).join('').trim()
    return base
  }

  /**
   * 由会话标题决定输出路径；同名会话自动加会话号区分。
   *
   * 光靠内存里的 fileOwner 不够：插件重启后它就从零开始了，此时磁盘上
   * 已经有别的会话的 `X.txt`，直接写就会把别人的文档覆盖掉。所以落笔前
   * 还要读一下磁盘上同名文件的文档头 —— 里面记着真正的会话 id。
   */
  function outPath(sessionId, records, arch) {
    const short = shortOf(sessionId)
    const all = records || [...(store.get(sessionId)?.records?.values() ?? [])]
    let base = titleToBase(titleOf(all), sessionId)
    const dir = dirFor(sessionId, arch)
    const holder = fileOwner.get(base)
    if (holder && holder !== sessionId) base = base + '-' + short
    const file = path.join(dir, base + '.txt')
    const diskOwner = fs.existsSync(file) ? ownerOf(file) : null
    let final = file
    let finalBase = base
    if (diskOwner && diskOwner !== sessionId) {
      finalBase = base + '-' + short
      final = path.join(dir, finalBase + '.txt')
    }
    fileOwner.set(finalBase, sessionId)
    return final
  }

  /** 读文档头里记的会话 id。不是我们自己生成的文件一律返回 null。 */
  function ownerOf(file) {
    try {
      const head = fs.readFileSync(file, 'utf8').slice(0, 800)
      if (!head.startsWith('DSH 对话记录')) return null
      const m = head.match(/^会话 {1,4}(session-[0-9a-zA-Z-]+)$/m)
      return m ? m[1] : null
    } catch {
      return null
    }
  }

  /** 跨设备/跨挂载点搬文件：rename 失败就退化成复制 + 删除。 */
  function moveFile(src, dest) {
    try { fs.renameSync(src, dest) } catch {
      fs.copyFileSync(src, dest)
      fs.unlinkSync(src)
    }
  }

  /** 把一份文档搬到目标目录；重名就加会话号，绝不去动别人的文件。 */
  function relocate(src, destDir, sessionId) {
    try {
      fs.mkdirSync(destDir, { recursive: true })
      const name = path.basename(src)
      let dest = path.join(destDir, name)
      if (path.resolve(dest) === path.resolve(src)) return src
      if (fs.existsSync(dest) && ownerOf(dest) !== sessionId) {
        dest = path.join(destDir, name.replace(/\.txt$/i, '-' + shortOf(sessionId) + '.txt'))
      }
      try { fs.unlinkSync(dest) } catch { /* 同名同会话，覆盖即可 */ }
      moveFile(src, dest)
      for (const [sid, at] of currentFile) if (at === src) currentFile.set(sid, dest)
      return dest
    } catch {
      return src
    }
  }

  /** 清掉崩溃残留的 .tmp（只清够老的，避免误删正在写的）。 */
  function cleanupTmp(dirs) {
    const now = Date.now()
    for (const d of dirs) {
      let names = []
      try { names = fs.readdirSync(d) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.tmp')) continue
        const p = path.join(d, n)
        try {
          const st = fs.statSync(p)
          if (now - st.mtimeMs > TMP_TTL_MS) fs.unlinkSync(p)
        } catch { /* 别人删掉了就算了 */ }
      }
    }
  }

  /**
   * 对账：把每份文档放回它该在的目录。
   *
   * 认人的依据是**文档头里记的完整会话 id**，不是文件名 —— 文件名跟着标题走，
   * 靠它认会话迟早认错。只处理首行是 `DSH 对话记录` 的文件，别的文件一概不碰。
   *
   * @param {boolean} force - 启动时强制跑一次；之后只在归档集合变化时跑。
   */
  function reconcile(force) {
    const arch = archivedIds()
    if (!arch) return   // 状态文件读不到就别动任何文档
    const key = [...arch].sort().join('|')
    if (!force && archState.key === key) return
    archState.key = key
    archState.set = arch

    const archDir = path.join(cfg.dir, ARCHIVE_SUBDIR)
    try { fs.mkdirSync(cfg.dir, { recursive: true }) } catch { /* 忽略 */ }
    cleanupTmp([cfg.dir, archDir])

    // 1) 旧目录里的历史文档 → 按归档状态迁进新目录
    try {
      for (const n of fs.readdirSync(LEGACY_DIR)) {
        if (!n.endsWith('.txt')) continue
        const src = path.join(LEGACY_DIR, n)
        const sid = ownerOf(src)
        if (sid) relocate(src, dirFor(sid, arch), sid)
      }
    } catch { /* 旧目录不存在就算了 */ }

    // 2) 主目录与归档目录之间互搬（归档就进子目录，取消归档就搬回来）
    for (const [from, wanted] of [[cfg.dir, false], [archDir, true]]) {
      let names = []
      try { names = fs.readdirSync(from) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.txt')) continue
        const src = path.join(from, n)
        const sid = ownerOf(src)
        if (!sid) continue                        // 不是我们的文件
        if (arch.has(sid) !== wanted) relocate(src, dirFor(sid, arch), sid)
      }
    }
  }

  /** 当前该用哪份归档集合（对账没跑过就现读一次）。 */
  function archNow() {
    if (archState.set) return archState.set
    const a = archivedIds()
    if (a) archState.set = a
    return a || new Set()
  }

  /** 渲染并写盘。任何异常都吞掉并记进 stats —— 绝不能影响对话。 */
  function exportSession(sessionId, depthOverride) {
    try {
      if (!cfg.enabled) return { ok: false, reason: '自动导出已关闭' }
      const e = store.get(sessionId)
      if (!e || e.records.size === 0) return { ok: false, reason: '没有这个会话的内存记录' }
      const records = [...e.records.values()]
      try { reconcile(false) } catch { /* 顺带把归档/取消归档的文档搬到位 */ }
      const arch = archNow()
      const text = render(records, { depth: depthOverride || cfg.depth, sessionId, clean: cfg.clean !== false })
      const target = outPath(sessionId, records, arch)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const prev = currentFile.get(sessionId)
      const tmp = target + '.' + tmpTag()
      try {
        fs.writeFileSync(tmp, text, 'utf8')
        fs.renameSync(tmp, target)   // 原子替换，避免读到写了一半的文件
      } catch (err) {
        try { fs.unlinkSync(tmp) } catch { /* 没写出来就不用删 */ }
        throw err
      }
      // 标题变了，或刚被归档/取消归档 → 删掉旧位置的文件，
      // 保证一个会话只有一个文档，而不是越攒越多。
      if (prev && prev !== target) {
        try { fs.unlinkSync(prev) } catch { /* 已经不在了就算了 */ }
      }
      currentFile.set(sessionId, target)
      stats.written += 1
      stats.lastPath = target
      stats.lastWriteAt = new Date().toISOString()
      stats.lastError = ''
      recent.unshift({ session: sessionId, file: target, at: stats.lastWriteAt })
      if (recent.length > 5) recent.pop()
      writeState()
      return { ok: true, path: target, bytes: Buffer.byteLength(text, 'utf8') }
    } catch (err) {
      stats.errors += 1
      stats.lastError = String(err && err.message ? err.message : err)
      writeState()
      try { ctx.logger?.warn?.('chatlog: 导出失败 ' + stats.lastError) } catch { /* 忽略 */ }
      return { ok: false, reason: stats.lastError }
    }
  }

  /**
   * 自动导出不能卡在事件回调里（全量重写 + 渲染对长会话是几十毫秒），
   * 所以丢到 setImmediate；同一个会话正在写就排队，写完再补一次。
   */
  const busy = new Set()
  const pending = new Set()
  function scheduleExport(sessionId) {
    if (busy.has(sessionId)) { pending.add(sessionId); return }
    busy.add(sessionId)
    setImmediate(() => {
      try { exportSession(sessionId) } catch { /* exportSession 自己已经兜住了 */ } finally {
        busy.delete(sessionId)
        if (pending.has(sessionId)) { pending.delete(sessionId); scheduleExport(sessionId) }
      }
    })
  }

  /** 子代理会话要不要跳过：header 缺字段时也不能漏判。 */
  function isSubagent(session, event) {
    const h = (session && session.header) || {}
    const d = typeof h.delegationDepth === 'number' ? h.delegationDepth
      : (event && typeof event.delegationDepth === 'number' ? event.delegationDepth : null)
    if (d !== null && d > 0) return true
    return Boolean(h.parentSessionId || (h.parent && h.parent.id))
  }

  /* ---- 唯一的钩子：会话事件流 ---- */
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      if (cfg.skipSubagents && isSubagent(session, event)) return

      const e = entryFor(session)
      if (!e.header && session.header) e.header = session.header
      e.records.set(event.seq, event)
      e.lastSeen = Date.now()
      lastActiveId = session.id
      trimStore(session.id)

      // turn/end 就是"这一轮答完了"。它自己也是最后一条记录，
      // 所以此刻渲染到的内容是完整的一轮。
      if (event.type === 'turn/end') scheduleExport(session.id)
    } catch (err) {
      try { ctx.logger?.warn?.('chatlog: 事件处理失败 ' + String(err && err.message)) } catch { /* 忽略 */ }
    }
  })

  /* ---- 手动导出工具 ----
   * 动态 import：万一 @deepseek-ai/dsh-tools 在这个 profile 里解析不到，
   * 插件本身仍能正常加载、自动导出照常工作，只是少这一个工具 ——
   * 而不是整个模块 import 失败把插件拖死。
   *
   * 默认**关闭**：它的 schema 会跟着每一次 API 请求发出去（约 300 token），
   * 不用的时候没必要占这份额度。自动导出完全不依赖它。
   * 想开就改配置 tools: true —— 不需要改代码。 */
  if (cfg.tools) {
    try {
      ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
    } catch (err) {
      toolsError = String(err && err.message ? err.message : err)
      try { ctx.logger?.warn?.('chatlog: 加载 dsh-tools 失败，手动导出工具不可用 ' + toolsError) } catch { /* 忽略 */ }
    }
  }
  if (cfg.tools && typeof defineTool === 'function') ctx.tools.register(defineTool({

    name: 'chatlog_export',
    description: '把某次 DSH 对话导出成本地纯文本 .txt。'
      + '不传参数就是"把当前这次对话导出成最新状态"，等价于自动导出干的事。'
      + 'depth=plain 只要对话正文（默认）；summary 多一行工具摘要；full 含思考过程和工具输入输出。',
    parameters: {
      session: { type: 'string', description: '会话 id（写前几位即可），或 latest 表示最近一次。省略=当前对话。' },
      depth: { type: 'string', enum: ['plain', 'summary', 'full'], description: '内容深度，默认 plain。' },
      out: { type: 'string', description: '指定输出文件路径，必须在插件配置的目录里面。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const depth = args && DEPTHS.has(args.depth) ? args.depth : cfg.depth
      const want = args && args.session ? String(args.session) : ''

      // 1) 命内存里已有的会话（正常情况下就是当前这次对话）
      let sessionId = null
      if (!want) {
        sessionId = lastActiveId || [...store.keys()].pop() || null
      } else if (want !== 'latest') {
        sessionId = [...store.keys()].find((k) => k.includes(want)) || null
      }

      // 2) 内存里没有（比如要导一次很久以前的对话）→ 从磁盘读
      let records = null
      let file = null
      if (sessionId && store.has(sessionId)) {
        records = [...store.get(sessionId).records.values()]
      } else {
        const all = candidateFiles()
        const hit = want && want !== 'latest'
          ? all.find((c) => c.id.includes(want))
          : all[0]
        if (!hit) return want ? ('找不到会话：' + want) : '找不到任何会话记录。'
        records = decodeSessionFile(hit.file)
        file = hit.file
        sessionId = (records.find((r) => r.type === 'session') || {}).id || hit.id
      }

      const text = render(records, { depth, sessionId, clean: cfg.clean !== false })
      const root = path.resolve(cfg.dir)
      let target
      if (args && args.out) {
        target = path.resolve(String(args.out))
        if (target !== root && !target.startsWith(root + path.sep)) {
          return 'out 只能写在导出目录里面：' + cfg.dir + '\n（这是为了避免一次导出把文件写到系统任意位置。）'
        }
      } else {
        target = outPath(sessionId, records, archNow())
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const tmp = target + '.' + tmpTag()
        try {
          fs.writeFileSync(tmp, text, 'utf8')
          fs.renameSync(tmp, target)
        } catch (err) {
          try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
          throw err
        }
      } catch (err) {
        return '写文件失败：' + String(err && err.message ? err.message : err)
      }
      currentFile.set(sessionId, target)
      stats.lastPath = target
      stats.lastWriteAt = new Date().toISOString()
      recent.unshift({ session: sessionId, file: target, at: stats.lastWriteAt })
      if (recent.length > 5) recent.pop()
      writeState()
      const kb = (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)
      return '已导出 ' + sessionId + '（depth=' + depth + '）→ ' + target + '  (' + kb + ' KB)'
        + (file ? '\n来源文件：' + file : '\n来源：内存中的实时会话记录')
    },
  }))

  /* ---- 启动时就把状态写出来：装上了 ≠ 真的生效 ---- */
  writeState()
  try {
    ctx.logger?.info?.('chatlog: 已加载 v' + VERSION + ' → ' + cfg.dir + '（depth=' + cfg.depth + '）')
  } catch { /* 忽略 */ }
}
