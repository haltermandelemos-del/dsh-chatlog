# dsh-chatlog

每轮对话结束，自动把当前 DSH 会话写成本地纯文本 `.txt`；另外提供一个手动导出工具（默认关闭）。

装上就不用管了 —— 聊天过程中什么都不用做，说完一轮，文档自己就在那了。

> A tiny plugin for **DeepSeek Harness (DSH)** that writes every chat session to a
> plain-text `.txt` file on each `turn/end`, with optional Markdown stripping.
> Zero dependencies, Node >= 18.

## 安装

还没发到 npm，用本地 tgz 装：

```bash
# 从仓库打一个包
git clone https://github.com/haltermandelemos-del/dsh-chatlog.git
cd dsh-chatlog
npm pack                      # 生成 dsh-chatlog-0.1.8.tgz

# 或者不装 git，直接下 Release 里现成的 tgz：
# https://github.com/haltermandelemos-del/dsh-chatlog/releases

# 装进 DSH 的 profile（web 是默认 profile 名，按自己的改）
dsh plugin --profile web add ./dsh-chatlog-0.1.8.tgz
```

装完 `dsh --profile web --dump-config` 里能看到 `- id: chatlog`。

插件自带 `cordis.patch.yml`（bundle 层自动 insert 一行），**不用手写** `insert` 配置；
要改参数再按 id 覆盖，见下面"配置"。

升级后若没生效：DSH 的 HMR 默认忽略 `node_modules`，改一下 profile 下的文件
（比如给 `cordis.patch.yml` 加一行注释再删掉）触发重载，或直接重启 DSH。

## 输出

默认目录 `/sdcard/dsh/dsh会话/`（手机文件管理器里能看到）：

```
/sdcard/dsh/dsh会话/
├── 帮我写一个备份脚本.txt        ← 一个会话 = 一个文档，每轮覆盖成最新
├── 安装最新版chatlog插件.txt
├── .chatlog-state.json          ← 插件自己的运行状态（见"自检"）
└── 归档会话/                     ← 在 DSH 里"删除"的会话挪到这里
    └── 旧的对话.txt
```

文档长这样：

```
DSH 对话记录
标题  安装最新版chatlog插件
会话  session-1a2b3c4d-...
目录  /sdcard/dsh
开始  2026/10/20 11:29:03
导出  2026/10/20 19:35:33
时区  Asia/Shanghai

你  2026/10/20 19:28:58
安装chatlog插件，在这个文件里有，装最新那版

助手  2026/10/20 19:29:31
好的，我看一下这个目录……
```

- **文件名跟着会话标题走**：标题异步生成、之后还会被改写，所以每轮写盘都重算名字，标题一变就改名（旧文件删掉）——一个会话始终只有一个文档，不会越攒越多。
- 还没标题时先用 `会话-<会话号前8位>.txt`，标题一到就改名。
- 标题里的 `/ : * ? " < > |` 换成空格，超过 40 字截断。
- **两个会话同名也不打架**：内存里按标题登记占用，落笔前还会读磁盘上同名文档的头部核对会话 id —— 撞名就自动追加 8 位会话号（重启后也一样，不会互相覆盖）。
- 写盘是"临时文件 + rename"原子替换，不会读到写了一半的文档。
- 在 DSH 里**删除会话**其实只是归档：文档会被挪进 `归档会话/`；取消归档再挪回来。

## 符号：正文会清成纯文本

助手的回复本身是 Markdown，原样存进 .txt 会到处是 `##`、`**`、反引号、表格竖线。
所以写盘前会做一遍**轻量清洗**（默认开，配置 `clean: false` 关）：

| 原文 | 存下来 |
|---|---|
| `## 标题` | 标题（去掉井号，单独一行） |
| `**加粗**` / `~~删除~~` | 加粗 / 删除 |
| `\`ls -la\`` | ls -la |
| `[文字](https://x.y)` | 文字（https://x.y） |
| `![截图](url)` | [图片: 截图] |
| `> 引用` | 引用（去掉 >） |
| `* 列表` / `+ 列表` | - 列表 |
| `| a | b |` | `a  b`（去竖线，两空格分隔） |
| `|---|---|` | 整行丢掉 |
| `---`（分割线） | `————————` |
| `\`\`\`js … \`\`\``（代码块） | 首尾换成 `————————`，**代码内容一个字都不动** |

刻意不做的两件事：

- **斜体 `*x*` 不处理** —— 会把 `2*3*4`、`a*b` 这类算式吃掉，得不偿失。
- **不折行、不对齐** —— 只是把标记去掉，段落怎么断还是怎么断。

代码块和行内代码会被先识别出来保护，里面的 `**`、`#`、`|` 全部原样保留。
清洗只作用于正文，文档头部那几行（标题/会话/时间）本来就是纯文本。

## 内容深度

| depth | 内容 |
|---|---|
| `plain`（默认） | 只有真人发言和助手回复 |
| `summary` | 额外在工具调用处加一行摘要，如 `工具 bash  description=…` |
| `full` | 再加思考过程、工具完整入参和输出（输出超 4000 字截断） |

注入类消息（`agent-instructions`、`runtime-context`、`user-approval` 等系统提示）默认丢弃；
`full` 模式下会以 `系统注入 …` 的形式保留短摘要。用户消息里的 `<system-reminder>` 段会被剥掉。

## 配置

在 profile 的 `cordis.patch.yml` 里**按 id 覆盖**，不要用 `insert`：

```yaml
- id: chatlog
  config:
    enabled: true
    dir: /sdcard/dsh/dsh会话
    depth: plain        # plain | summary | full
    clean: true         # 把正文里的 Markdown 标记清成纯文本（默认开）
    skipSubagents: true
    tools: false        # 是否注册 chatlog_export 手动导出工具（默认 false）
```

> ⚠️ **别写成 `- insert: - id: chatlog`**。这个插件的 bundle 层（自带的
> `cordis.patch.yml`）已经 insert 过一行 `id: chatlog` 了，用户在 profile 里再
> insert 一行，结果是同一个 id 出现两次：要么插件被挂两遍（每轮重复导出），
> 要么你的 `config` 落到没人用的那一行上，配置静默不生效。
> 按 id 覆盖是对的 —— DSH 会把这条 patch 合并到已有 entry 上。

只写你要改的键就行，其余沿用默认值（默认值：`enabled: true`、`depth: plain`、
`dir: /sdcard/dsh/dsh会话`、`clean: true`、`skipSubagents: true`、`tools: false`）。

配置写错（比如 `depth: deeply`）不会让插件崩掉：回退到默认值，并把原因记进状态文件的 `warnings`。

## 手动导出工具（默认关闭）

`chatlog_export` 的 schema 会跟着**每一次 API 请求**发出去（约 300 token）。
不用它的时候把 `tools` 留在 `false` —— 自动导出完全不受影响。

开了之后：

- `session`：会话 id（写前几位即可）或 `latest`；省略 = 当前对话
- `depth`：`plain` / `summary` / `full`
- `out`：输出路径，**必须在配置的导出目录里面**（防止一次导出把文件写到系统任意位置）

## 自检

装上了 ≠ 真的生效，所以插件把运行状态写在输出目录的 `.chatlog-state.json`：

```json
{
  "plugin": "dsh-chatlog",
  "version": "0.1.8",
  "hook": "session/event (turn/end)",
  "loadedAt": "2026-10-20T11:30:09.000Z",
  "updatedAt": "2026-10-20T11:35:33.000Z",
  "dir": "/sdcard/dsh/dsh会话",
  "depth": "plain",
  "clean": true,
  "written": 2,
  "errors": 0,
  "lastWriteAt": "2026-10-20T11:35:33.000Z",
  "lastPath": "/sdcard/dsh/dsh会话/安装最新版chatlog插件.txt",
  "lastError": "",
  "sessionsInMemory": 1,
  "recent": [ { "session": "session-…", "file": "…", "at": "…" } ],
  "warnings": []
}
```

判断标准很简单：

- `written` 每轮 +1 → 自动导出在工作。
- `lastWriteAt` 是你刚说完话的时间 → 就是这一刻写的。
- `errors` > 0 看 `lastError`。
- 文件里根本没有这个 json → 插件没加载（查 profile 的 `bundles` 有没有 `dsh-chatlog`）。

（0.1.6 及更早写的是 `plugin-loaded.txt`，只有启动那一刻的信息，0.1.7 起换成上面这份；旧文件可以删。）

## 已知边界

- **不导出你在这台机器之外发生的事**：只记录本 profile 的会话文件。
- 插件只处理首行是 `DSH 对话记录` 的文档，目录里别的文件一概不碰。
- 归档对账在**启动时**和**归档集合变化时**各跑一次，不是每轮都跑 —— 因此你手工把文档挪到别处后，不会被立刻搬回来。
- `plain` 模式下工具调用完全不出现；想看到"它都干了什么"用 `summary`。
- 零第三方依赖，安装不需要联网。
