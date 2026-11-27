# dsh-memory

给 DeepSeek Harness 用的持久化项目记忆插件。思路取 Claude Code 记忆机制里真正有用的那一半：**一个每次会话注入一次的 `MEMORY.md` 索引 + 按需读取的 markdown 笔记文件**，而不是复刻整套 `CLAUDE.md` 指令体系（那部分 DSH 的 `dsh-agent-instructions` 已经做了）。

## 它做什么

- 每个项目一个记忆目录：`$DSH_HOME/memory/<项目名>-<路径哈希>/`
- 每个会话（以及压缩后）注入一条带帧的上下文消息，内容是记忆索引 + 何时该记、何时不该记
- 三个模型工具：`memory_write`（写笔记并原子维护索引行）、`memory_read`（有界读取）、`memory_search`（按行字面检索）
- 笔记是纯 markdown，可以手工编辑、删除、备份；不进仓库、不出现在 `git status`

## 目录结构

```
memory/<项目名>-<root hash>/
├── MEMORY.md       # 索引：一行一条
├── testing.md      # 一条记忆一个文件
└── release-flow.md
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

- `src/index.ts`、`src/paths.ts`、`src/render.ts`、`src/store.ts`：Host 半插件（工具、注入、面板路由）
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
```

## 为什么写侧要自己实现

本 profile 挂的是 `dsh-fs-sandbox`，`workspace-write` 模式下 `ctx.fs` 的写操作被限制在 workspace 内，写不到 `$DSH_HOME`。所以记忆文件由插件在 Host 侧原子写入，模型通过 `memory_write` 写入；读侧不受限，插件和模型都能直接读。

## 测试

```sh
npm test
```

覆盖存储层、路径越界防护、索引对账、预算截断，以及 pre-step 注入契约。测试直接运行 `tests/*.test.ts`（Node 原生类型剥离），不需要先构建。

## 界面

Client 半插件提供两块：

1. **聊天行**：每次注入渲染成一行「项目记忆 · N 条」，可展开看完整索引。它用 `exclusive` 抢占该消息，内建上下文的折叠分类不会再接管，所以固定出现在轮次里、不并入过程折叠区。
2. **`/memory` 面板**：列出索引、查看/编辑正文、新建、删除。数据走 Host 的 owner-only 精确路由 `POST /api/memory`，和工具共用同一份 store 操作；面板写入不向 agent 会话确认，因此 agent 下一轮会自动看到更新后的索引。

## 已知边界

- 检索是字面匹配，没有向量/语义召回
- 只有一个项目作用域，没有用户全局记忆和按路径生效的规则树
- 没有自动整理/去重/过期机制
- 索引在每轮开始时重组，外部编辑下一轮才可见

更完整的行为说明见 `docs/DETAIL.md`。
