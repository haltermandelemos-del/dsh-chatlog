# dsh-chatlog

把 DSH 的每个会话导出成本地纯文本文档，并按「还活着 / 已归档」自动分文件夹。

## 规则

```
/sdcard/dsh/DshChat/<标题>-<会话号8位>.txt              还活着的会话
/sdcard/dsh/DshChat/DeletedChat/<标题>-<会话号8位>.txt  归档的、或会话文件已经不在了的
```

- **活着** = 磁盘上还有它的会话文件，或本轮对话正在往它上面写事件。
- **归档** = `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` 里有它。
  DSH 界面上的「删除会话」其实就是归档：只往这个集合里加一个 id，会话文件原地不动。
- 会话文件被删掉（或整个会话目录搬家）之后，对应的文档也会自动进 `DeletedChat`。

## 行为

- 每轮对话结束（`turn/end`）重写一次这个会话的文档；同时顺手对一次账，
  把该归档的文档搬进 `DeletedChat`、该回来的搬回根目录。
- 启动时全量同步一次：会话文件比文档新（或还没有文档）的，补一份。
- 每份文档开头都写着自己是哪个会话（`会话  session-...` 那一行），
  插件只靠这一行认领文件 —— **不是自己写的 .txt 一概不读不写不删不改名**。
- 一个会话只保留一份文档：标题变了就改名，旧的那份删掉。

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不再导出，也不会再搬文件 |
| `dir` | `/sdcard/dsh/DshChat` | 输出根目录 |
| `archiveSubdir` | `DeletedChat` | 归档子目录名 |
| `tz` | `Asia/Shanghai` | 文档里的时间用哪个时区 |
| `showTools` | `true` | 是否记下工具调用与结果 |
| `showReasoning` | `false` | 是否记下模型的思考内容 |
| `maxResultLines` | `6` | 单条工具结果最多保留几行 |
| `clean` | `true` | 去掉 Markdown 标记，输出干净的纯文本 |
| `syncMs` | `60000` | 后台同步间隔（毫秒）；`0` 表示只在启动和每轮结束时同步 |
| `skipSubagents` | `true` | 跳过子代理会话 |

## 文档长什么样

```
DSH 对话记录
标题  去完成我学习通上的作业
会话  session-12e98f31-c76b-4f97-8267-2e865d0595b8
目录  /root
开始  2026/10/30 12:04:25
导出  2026/11/05 12:58:50
时区  Asia/Shanghai

—— 2026/10/30 12:05:15 · 你 ——
去完成我学习通上的作业

—— 2026/10/30 12:05:18 · 助手 ——
先看一下手机状态。

—— 2026/10/30 12:05:18 · 工具 ——
→ phone_status {}
← phone_status
  无障碍服务: 已开启
  当前前台: com.dshmobile.probe
```

## 出问题先看这里

`DshChat/.chatlog-state.json` 里有 `written` / `moved` / `errors` / `lastError` /
`lastPath`，以及加载时收集到的配置告警。写盘一律「临时文件 + rename」，
不会出现写到一半的文档；崩溃残留的临时文件（`.chatlog-<pid>.<tag>.tmp`）
超过 6 小时会在下次启动时清掉。
