# 用户全局记忆：设计记录

- 日期：2026-11-28
- 状态：已实现（G1/G2），全局整理留待后续
- 相关：[DETAIL.md](./DETAIL.md)、[ROADMAP.md](./ROADMAP.md)

## 1. 边界

本插件只做 auto-memory。**人类写的全局规则**仍归 `dsh-agent-instructions`
（`$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md`）；本文件讨论的是 agent 自己
写、跨项目复用的笔记。

Claude Code 的 auto memory 是 per-repository；用户级只有 `CLAUDE.md` 指令。
因此用户全局记忆是本插件的扩展，不是对 Claude Code 的补齐。

已确认的范围：

- 只有**用户全局**一层，不做团队/组织作用域，也不做路径作用域规则。
- 全局目录是 `$DSH_HOME/memory/global/`，不带下划线前缀。项目目录名始终带
  root hash，所以和 `global` 不会混淆。
- 全局层默认开启；没有笔记时不注入，不产生上下文成本。
- 全局层和项目层**预算独立**。
- 全局层暂不做整理：没有全局 `memory_audit`、`memory_sweep`、
  `memory_dream`，面板的“整理”也只作用于项目层。
- `memory_read` 不回退到另一层；在所选层找不到就显式报错，错误里提示用
  `scope: 'global'` 或 `memory_search`。

## 2. 存储

```text
$DSH_HOME/memory/
├── global/                 # 用户级，跨所有项目
│   ├── MEMORY.md
│   ├── preferences.md
│   └── archive/
└── dsh-mem-1a2b3c4d5e/     # 现有项目级，布局不变
```

全局目录使用同一套 `MEMORY.md`、主题文件、`archive/` 和 `.store.lock`。
项目目录、索引格式、归档 manifest 都不变，旧目录零迁移。

## 3. 注入

一个会话仍然只注入一条 `memory` 消息；消息里先全局、后项目：

```text
<system-reminder>
User-global memory: 2 notes saved in earlier sessions. These notes apply
across projects; when they conflict with a project note, the project note wins.
...
---
Project memory for `/work/project`: 3 notes saved in earlier sessions.
...
</system-reminder>
```

- 全局默认预算 40 行 / 6000 字节；项目预算保持 200 行 / 25000 字节。
- 全局为空或 `globalMemoryEnabled: false` 时不渲染全局段。
- 注入文本明确：两层都是参考，不是指令；项目笔记更具体，冲突时项目优先。
- `MemoryMessageSource` 增加可选的 `globalMemoryDir`、`globalEntryCount`。
  `entryCount` 仍表示项目条目数，旧会话事件保持可渲染。
- digest 覆盖“全局文本 + 项目文本”。任一层外部变化都会触发下一轮重新注入；
  本会话自己的写仍然只更新确认 digest，不重复注入整份索引。

## 4. 工具

写入、读取、搜索、删除、恢复五个工具增加可选的 `scope: 'project' | 'global'`，默认 `project`。

| 工具 | 行为 |
|---|---|
| `memory_write` | 默认写项目；显式 `scope: 'global'` 才写全局。全局只用于跨项目偏好。 |
| `memory_read` | 按 scope 读；找不到显式报错，不回退到另一层。 |
| `memory_search` | 默认先搜项目、再搜全局，结果带 `scope`；可用 `scope` 只搜一层。 |
| `memory_delete` | 按 scope 删除；默认项目，全局必须显式 scope。 |
| `memory_restore` | 按 scope 从该层 `archive/` 恢复。 |
| `memory_audit` / `memory_sweep` / `memory_dream` | 仍然只作用于项目层。 |

搜索结果不抢占预算：先搜项目，项目没有截断且未占满 `limit` 时，用剩余
`limit` 和剩余字节预算继续搜全局；任一层截断则整体 `truncated: true`。

写入确认：一次写之后重新加载两层索引并计算合并 digest，避免“全局变了但项目
没变，所以不重新注入”。

## 5. 面板

- `/memory` 面板顶部增加“项目 / 全局”切换。
- `POST /api/memory` 增加 `scope` 参数，默认 `project`；返回 `{ scope, dir,
  entries }`。
- 全局 tab 复用列表、查看、编辑、新建、归档、永久删除。
- “整理”只在项目 tab 显示；全局层在 v1 没有 audit/sweep。
- 全局删除的确认文案明确“所有项目都会看不到它”。

## 6. 配置

```yaml
- id: memory
  name: '@local/dsh-memory'
  config:
    globalMemoryEnabled: true
    maxGlobalIndexLines: 40
    maxGlobalIndexBytes: 6000
```

项目预算配置不变。`globalMemoryEnabled: false` 时既不注入全局层，也拒绝
`scope: 'global'` 的工具调用和面板请求。

## 7. 非目标（v1）

- 团队/组织共享记忆、云同步。
- 全局 Auto Dream、全局审计/清扫、全局 `.state.json`。
- 跨层重复检测与自动合并；v1 只靠“项目优先”和写入提示。
- 路径作用域规则。
- 全局笔记的加密或 secret 扫描；继续由写入提示要求不存 secret。

## 8. 实施与验收

| 阶段 | 内容 |
|---|---|
| G1 | `globalMemoryDir`、配置、双段渲染、digest/ack、路径与注入测试 |
| G2 | 五个工具的 scope、面板切换、路由、locale、测试、文档 |

验收标准：

- 默认配置下，没有全局笔记时注入文本与现在完全一致。
- 写一条全局笔记后，新会话同时看到全局段和项目段；项目预算不受影响。
- `memory_read({ file })` 在项目层找不到时返回明确错误，不偷偷读全局。
- `memory_search` 默认两层都搜，每条结果带 scope；`scope: 'global'` 只搜全局。
- 全局删除/恢复只作用于 `$DSH_HOME/memory/global/`。
- `globalMemoryEnabled: false` 时工具和面板都拒绝全局操作。
- `npm run typecheck`、`npm test`、`npm run build` 全绿。
