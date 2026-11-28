# 路线图：从基础记忆到可维护的记忆

- 日期：2026-11-27
- 当前版本：`0.3.0`（TypeScript + tsdown，测试 57 项通过）
- 相关：[CURATION.md](./CURATION.md)（整理功能详细设计）、[DETAIL.md](./DETAIL.md)

## 1. 基线

已经完成并验证：

- 每个项目一个记忆目录，`MEMORY.md` 索引 + 一篇笔记一个文件。
- 会话开始时注入一次索引（200 行 / 25 KB 预算），压缩或外部变更后重新注入。
- 八个模型工具：`memory_write`、`memory_read`、`memory_search`、`memory_delete`、`memory_audit`、`memory_sweep`、`memory_restore`、`memory_dream`。
- 写入确认机制：同会话自己的写不会重复注入整份索引。
- `/memory` 面板：列表、查看、编辑、新建、删除，走 owner-only 路由。
- 聊天行：每次注入渲染成独立可展开行。
- 存储层、路径围栏、索引对账、预算截断、写锁、软删除/归档、恢复、确定性清扫、相似提示、审计、Auto Dream 状态机与受限子会话、注入契约、面板路由都有测试。

不在本插件范围内（已确认）：

- `AGENTS.md` / `CLAUDE.md` 指令链由 `dsh-agent-instructions` 负责。
- 本插件只做 auto-memory 层。

## 2. 进展

**M1 已完成（2026-11-27）**：项目级写锁、`memory_delete`（默认归档）、`memory_audit`、写入相似提示、索引超预算提示。

**M2 已完成（2026-11-28）**：`memory_sweep`（默认 dry-run、空笔记/精确重复/旧临时文件/可选的预算溢出归档）、`memory_restore`（同名冲突拒绝）、面板“整理”报告与执行清扫、删除默认归档 + 永久删除二次确认。

**M2 现场验收（2026-11-28）**：`memory_sweep` dry-run 报 3 → 2 条、预演归档 1 条；`dryRun: false` 归档了重复笔记并重写索引；`archive/.manifest.json` 记录了精确原文件名；`memory_restore` 恢复成功并清掉 manifest 条目；随后永久删除临时笔记，索引回到 1 条。`/api/memory` 对非 owner 的 curl 返回 401，符合 owner-only 设计；面板点击仍需人工看一眼。

**M3 已完成（2026-11-27）**：`.state.json` 门槛（24h + 5 会话 + 重试窗口）、受限整理子会话（只保留记忆工具）、超时与 `.dream.lock`、递归守卫、手动 `memory_dream`。50 项测试、typecheck、build 通过。

**M3 真实验收（2026-11-27）**：手动 `memory_dream` 在运行中的 Host 上创建子会话并完成一轮。会话日志确认：`origin: subagent`、`delegationDepth: 1`；`request/header` 的工具列表只有五个 `memory_*`；实际调用为 `memory_audit`、`memory_search`、`memory_read`；`turn/end` 为 `completed`；`.state.json` 写入 `lastCuratedAt`、`lastCuratedBy: "dream"`、`lastCuration`，两个锁文件都已清理，索引保持 1 条。自动门槛的现场触发尚未开启验证，当前由固定时钟单测覆盖。

下面的差距清单保留为 M2/M4 的输入。

## 3. 差距清单

### P0 — 整理能力（M1 已补齐地基，M2/M3 继续）

见 [CURATION.md](./CURATION.md)。M1 后 agent 能判断和软删除，但仍不能自动收敛。

| 缺口 | 现状证据 | 归属 | 状态 |
|---|---|---|---|
| 模型不能删除/归档笔记 | 原三个工具里没有 delete；只有面板路由能删 | M1 | ✅ |
| 没有重复检测 | 现在由 `memory_audit` 的标题/正文相似度覆盖 | M1 | ✅ |
| 没有过期/超长判断 | `memory_audit` 现在报告 stale / oversized | M1 | ✅ |
| 没有整理触发信号 | 注入在超预算时指向 `memory_audit` / `memory_delete` | M1 | ✅ |
| 没有确定性清扫 | 已由 `memory_sweep` 覆盖 | M2 | ✅ |
| 没有归档/恢复 | 归档与 `memory_restore` 均已实现 | M1/M2 | ✅ |
| 没有自动整理 | 已由 M3 的 Auto Dream / `memory_dream` 覆盖 | M3 | ✅ |
| 面板没有整理入口 | 面板已有“整理”、归档和永久删除 | M2 | ✅ |

### P1 — 正确性与并发

| 问题 | 影响 | 归属 |
|---|---|---|
| 索引“读-改-写”无锁 | 多会话并发写会丢索引行；靠 `loadIndex` 兜底但顺序/摘要会乱 | M1 ✅ |
| `searchMemory` 用字符数当字节数 | `maxSearchBytes` 在非 ASCII 文本下失真 | M4 |
| `readBoundedText` 按字节截断 | 可能切断多字节 UTF-8 字符，返回替换符 | M4 |
| `pre-step` 每个 step 都全量读笔记头 | 一轮多 step 重复 I/O，笔记多时变慢 | M4 |
| 临时文件崩溃残留 | `*.tmp` 可能长期堆积 | M2 |

### P2 — 召回与作用域（需要产品决策）

| 方向 | 说明 | 状态 |
|---|---|---|
| 语义/BM25 检索 | 当前是逐行字面匹配；没有 embedding | 待定 |
| 标签、`[[链接]]` | 笔记之间没有关系 | 待定 |
| 用户全局记忆 | 目前只有项目级；全局层是否纳入未定 | 待定 |
| 路径作用域规则 | 与指令系统边界重叠，倾向不做 | 待定 |
| watcher | 外部编辑下一轮才可见 | 可延后 |

### P3 — 产品化

| 项 | 说明 |
|---|---|
| CI | 目前只有本地 `npm test` / `npm run typecheck` |
| CHANGELOG | 版本到了 0.3.0，没有变更记录 |
| 文档同步 | 中文 README 与英文 DETAIL 已有轻微漂移 |
| 客户端测试 | 面板路由有测试，Client 渲染/交互没有 |
| 文件权限 | 记忆可能含敏感信息，建议目录 0700 / 文件 0600 |
| 归档清理 | 归档只增不减，后续需要保留策略 |

## 4. 里程碑

| 里程碑 | 目标 | 主要交付 | 验收 |
|---|---|---|---|
| **M1 整理地基（已完成）** | 让 agent 能判断和清理记忆 | 项目锁、`memory_delete`（默认归档）、`memory_audit`、写入相似提示、预算提示、配置、测试 | 能删除/归档、能拿到重复/过期/超长报告、并发写不丢行、测试全绿 |
| **M2 清扫与面板（已完成）** | 让整理可见、可撤销 | `memory_sweep`、`memory_restore`、`archiveOverflow`、面板整理报告、归档/永久删除 | dry-run 不落盘；清扫只处理确定性项；归档可恢复；面板可用 |
| **M3 Auto Dream（已完成）** | 自动语义整理 | `.state.json`、24h + 5 会话门槛、受限整理子会话、整理提示词、超时与锁、`memory_dream` 手动触发 | 默认关闭；开启后按门槛只跑一次；不递归、不并发、失败不阻塞 |
| **M4 收尾** | 性能与产品化 | mtime 缓存、搜索字节 bug、UTF-8 截断、CI、CHANGELOG、权限、文档 | 性能可接受；CI 绿；文档与实现一致 |

依赖：M2 依赖 M1 的锁和归档；M3 依赖 M1 的审计和 M2 的清扫；M4 独立，可穿插。

估时（理想人日）：M1 1.5–2，M2 2–3，M3 3–5（含 spike 风险），M4 1–2。

## 5. 发布计划

| 版本 | 内容 | 兼容性 |
|---|---|---|
| `0.4.0` | M1 + M2 + M3：审计、软删除/恢复、确定性清扫、面板整理、Auto Dream（默认关闭） | 索引格式不变；旧目录自动兼容；新增配置都有默认值 |
| `0.5.0` | M4：性能、编码 bug、CI、文档收尾 | 行为不变 |
| `0.6.0` | 可能的召回/作用域扩展 | 待定 |

每个版本都要求：`npm run build`、`npm run typecheck`、`npm test` 通过；新工具的描述和 schema 在 `DETAIL.md` 更新；README 的“已知边界”同步删改。

## 6. 非目标（当前明确不做）

- 复刻 Claude Code 的完整记忆机制（指令层、`@path` import、规则树）。
- 多用户/多租户记忆。
- 云同步、加密存储。
- 自动永久删除任何笔记。
- 在未验证工具限制的情况下创建可执行 shell 的整理子会话。

## 7. 建议的下一步

1. 已确认：软删除、Auto Dream 默认关闭、近似重复只报告。剩余待定项（模型路由、全局作用域、归档溢出）见 [CURATION.md](./CURATION.md) 第 13 节。
2. M1、M2、M3 已完成。下一步是 M4：`pre-step` 缓存、`searchMemory` 字节 bug、UTF-8 截断、CI/CHANGELOG、文件权限。
3. 自动门槛的现场触发仍未开启验证；可用较低的 `curationMinHours`/`curationMinSessions` 在测试项目上验收。
