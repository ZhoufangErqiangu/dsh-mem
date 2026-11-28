# dsh-memory

给 DeepSeek Harness 用的持久化项目记忆插件。思路取 Claude Code 记忆机制里真正有用的那一半：**一个每次会话注入一次的 `MEMORY.md` 索引 + 按需读取的 markdown 笔记文件**，而不是复刻整套 `CLAUDE.md` 指令体系（那部分 DSH 的 `dsh-agent-instructions` 已经做了）。

## 它做什么

- 每个项目一个记忆目录：`$DSH_HOME/memory/<项目名>-<路径哈希>/`
- 每个会话（以及压缩后）注入一条带帧的上下文消息，内容是记忆索引 + 何时该记、何时不该记
- 八个模型工具：`memory_write`（写笔记并原子维护索引行，写入时提示相似笔记）、`memory_read`（有界读取）、`memory_search`（按行字面检索）、`memory_delete`（默认归档，可永久删除）、`memory_audit`（重复/过期/超长/预算报告）、`memory_sweep`（确定性清扫，默认 dry-run）、`memory_restore`（从 archive/ 恢复）、`memory_dream`（手动跑一次整理会话）
- 笔记是纯 markdown，可以手工编辑、删除、备份；不进仓库、不出现在 `git status`

## 目录结构

```
memory/<项目名>-<root hash>/
├── MEMORY.md       # 索引：一行一条
├── testing.md      # 一条记忆一个文件
├── release-flow.md
└── archive/        # 软删除目录（含 .manifest.json），不进入索引/搜索
```

项目根按最近的 `.git` 祖先目录判定，和 DSH 的工作区指令作用域一致。索引每次会话开始时都会和目录对账：手工加的文件会被发现，手工删的文件其索引行会被丢弃。

## 安装

源码是 TypeScript，插件入口是构建产物 `lib/`，所以从 checkout 安装前先构建：

```sh
npm install
npm run build
```

然后在 DSH 的 **Plugins → Add plugin** 里选择本目录，或者让 agent 用 `plugin_manager` 的 `install_bundle` 安装。安装后在新会话里验证。

## 构建与开发

```sh
npm install
npm run build      # tsdown：lib/index.js（Host）+ lib/client.js（Client）
npm run typecheck  # tsc --noEmit，检查 src/ 与 tests/
npm test           # node --test tests/*.test.ts
```

- `src/index.ts`、`src/paths.ts`、`src/render.ts`、`src/store.ts`、`src/audit.ts`、`src/lock.ts`、`src/similarity.ts`：Host 半插件（工具、注入、面板路由、审计、写锁、相似度）
- `src/client/index.ts`、`src/client/contracts.ts`：Client 半插件（聊天行、`/memory` 面板）；`tsdown` 把入口包成 `window.__ModuleLoader__.load` 的 CJS 工厂，React 从页面模块表解析
- `lib/` 是构建产物，不入库；安装包只包含 `lib/`，不含 `src/`

## 配置

```yaml
- id: memory
  name: '@local/dsh-memory'
  config:
    maxIndexLines: 200        # 索引最多渲染多少行
    maxIndexBytes: 25000      # 索引最多渲染多少字节（默认对齐 Claude Code 的 200 行 / 25KB）
    maxTopicBytes: 65536      # memory_read 单次返回上限
    maxSearchResults: 20      # memory_search 默认返回条数
    maxSearchBytes: 4194304   # memory_search 扫描上限
    staleDays: 90             # 超过多少天未更新的笔记算过期
    duplicateThreshold: 0.6   # 标题/摘要相似度达到多少报告为近似重复
    oversizeBytes: 16384      # 超过多少字节报告为超长
    maxAuditNotes: 200        # 一次 memory_audit 最多检查多少篇
    archiveOverflow: false    # 清扫时是否自动归档超预算的最旧笔记
    curationEnabled: false    # Auto Dream 总开关，默认关闭
    curationMinHours: 24      # 距上次成功整理至少多少小时
    curationMinSessions: 5    # 距上次成功整理至少多少个会话
    curationRetryHours: 1     # 失败后至少隔多久再试
    curationTimeoutMs: 600000 # 单次整理超时
    curationProvider: ''      # 留空跟随当前会话路由
    curationModel: ''         # 留空跟随当前会话模型
    curationMaxTokens: 4096   # 整理会话单次输出上限
```

## 为什么写侧要自己实现

本 profile 挂的是 `dsh-fs-sandbox`，`workspace-write` 模式下 `ctx.fs` 的写操作被限制在 workspace 内，写不到 `$DSH_HOME`。所以记忆文件由插件在 Host 侧原子写入，模型通过 `memory_write` 写入；读侧不受限，插件和模型都能直接读。

新建的记忆目录使用 `0700`、笔记文件使用 `0600`（Windows 忽略）；已有目录和文件不会被强行改权限。

## 测试

```sh
npm test
```

覆盖存储层、路径越界防护、索引对账、预算截断、写锁、软删除/归档、恢复、确定性清扫、相似提示、审计的重复/过期/超长判断、整理状态机与整理子会话，以及 pre-step 注入契约。当前 57 项。

测试直接运行 `tests/*.test.ts`（Node 原生类型剥离），不需要先构建。

## 界面

Client 半插件提供两块：

1. **聊天行**：每次注入渲染成一行「项目记忆 · N 条」，可展开看完整索引。它用 `exclusive` 抢占该消息，内建上下文的折叠分类不会再接管，所以固定出现在轮次里、不并入过程折叠区。
2. **`/memory` 面板**：列出索引、查看/编辑正文、新建、归档/永久删除，并提供“整理”：先看审计报告，再执行确定性清扫。数据走 Host 的 owner-only 精确路由 `POST /api/memory`，和工具共用同一份 store 操作；面板写入不向 agent 会话确认，因此 agent 下一轮会自动看到更新后的索引。

## 整理

- `memory_audit`：只读报告，列出近似重复、过期、超长和预算压力。
- `memory_sweep`：默认 dry-run；`dryRun: false` 时归档空笔记和完全重复的笔记、清理旧临时文件、重写索引；`archiveOverflow: true` 时还会归档最旧的笔记直到索引回到 80% 预算。
- `memory_restore`：按归档文件名把笔记移回顶层，目标同名时拒绝覆盖。
- 面板“整理”提供同样的审计报告和执行清扫入口。

## 自动整理（Auto Dream）

默认关闭。开启后，每个项目在“距上次成功整理至少 `curationMinHours` 小时”且“累计至少 `curationMinSessions` 个会话”时，会在会话开始时异步启动一次独立整理会话；单项目同时只允许一个，失败或超时会记录在 `.state.json`，并在 `curationRetryHours` 后才会重试。

整理会话是一个受限制的子代理：只保留 `memory_*` 工具，工作目录固定为项目根，提示词禁止永久删除和访问记忆目录以外的文件。它按 `memory_audit` → 读笔记 → 合并/归档的顺序工作，结束后子会话被销毁。

不想等门槛时，可以显式调用 `memory_dream` 立即跑一次；它会使用一个模型 turn，适合在手动确认后整理。两者的设计见 `docs/CURATION.md`。

## 已知边界

- 检索是字面匹配，没有向量/语义召回
- 只有一个项目作用域，没有用户全局记忆和按路径生效的规则树
- 已有手动审计（`memory_audit`）、软删除（`memory_delete`）、确定性清扫（`memory_sweep`）、恢复（`memory_restore`）和可选的 Auto Dream
- Auto Dream 默认关闭；开启后需要同时满足 `curationMinHours` 和 `curationMinSessions` 才会触发，单次有超时和项目级锁
- 近似重复只报告，不自动合并；只有空笔记和正文完全相同的笔记会在清扫中被归档
- 面板的“归档”默认软删除，“永久删除”需要二次确认
- 索引在每轮开始时重组，外部编辑下一轮才可见

更完整的行为说明见 `docs/DETAIL.md`，版本变更见 `CHANGELOG.md`。

## 规划

整理（curation）与 Auto Dream 的设计、里程碑和待定决策见 `docs/CURATION.md` 与 `docs/ROADMAP.md`。M1（写锁、软删除、审计、相似提示、预算提示）、M2（确定性清扫、恢复、面板整理）和 M3（Auto Dream、`memory_dream`）已实现；M4（性能、CI、文档收尾）仍待做。
