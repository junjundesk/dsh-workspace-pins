# 工作区固定 · dsh-workspace-pins

> 一个 **dsh 插件**（DeepSeek DSH 的 Web UI 插件）：把常用的工作区钉在侧边栏最上面，
> 顺序不再被新建的文件夹挤乱；需要的话，还能把不要的工作区连同它的对话记录一起永久删掉。

| | |
| --- | --- |
| 插件包名 | `dsh-workspace-pins` |
| 支持 dsh | **≥ `0.2.2-alpha.2`**（`engines.dsh` 声明，该版本实测通过） |
| 平台 | Web（`dsh.client.platform: web`） |
| 第三方依赖 | 无 |
| 许可证 | MIT |

## 支持的 dsh 版本

- **实测版本**：`0.2.2-alpha.2`（Windows 11 + `web` profile）。
- **声明范围**：`package.json` 的 `engines.dsh: ">=0.2.2-alpha.2"`。低于这个版本时，dsh 会在
  跑 pnpm **之前**就拒绝安装（清单检查），不会留下装了一半的 profile。
- 查看本机版本：`dsh --version`。

这个下限来自插件真正用到的宿主接口：

| 用到的能力 | 用途 |
| --- | --- |
| 客户端服务 `workspaces`：`insertBefore` / `archiveSession` / `delete` | 排序、归档、移除注册 |
| slot `sidebar.footer.action`、`shell.overlay` | 侧边栏底部图钉按钮、浮层面板 |
| slot 标准 props `useWorkspaces` | 读工作区列表与它名下的会话 |
| 客户端 `sessions.refresh()` | 删完记录后刷新会话列表 |
| 宿主 `ctx.webServer.register()` | 删除会话记录的 HTTP 端点 |

更早的版本里这些接口未必齐备，未做验证。

## 安装

### 方式一：插件管理器（推荐）

1. 打开 dsh 的 Web UI（默认 `http://127.0.0.1:3080`）；
2. 左下角 **设置 → 插件**；
3. 选 **从本地目录安装**（给的是 `link:` 目标），指向 clone 下来的 `dsh-workspace-pins` 目录；
4. 装完刷新页面，侧边栏底部、设置图标旁边会多出图钉按钮。

管理器会自动写好依赖、`dsh.profile.bundles` 和 patch 三处，不用手工改文件。

### 方式二：命令行 + 手工清单

```bash
# 1) 拿到代码
git clone https://github.com/junjundesk/dsh-workspace-pins.git
cd dsh-workspace-pins

# 2) 把目录链进 profile（dsh plugin 等价于在 profile 目录里跑 pnpm）
dsh plugin --profile web add link:"$(pwd)"
```

`pnpm add` 只会写依赖，还要补两处（插件管理器会自动做，命令行不会）：

`~/.dsh/profiles/web/package.json`

```jsonc
{
  "dependencies": {
    "dsh-workspace-pins": "link:/绝对路径/dsh-workspace-pins"   // 上面命令已写好
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-workspace-pins"]                      // ← 手工加这一项
    }
  }
}
```

`~/.dsh/profiles/web/cordis.patch.yml` 末尾：

```yaml
- insert:
    - id: workspace-pins
      name: dsh-workspace-pins
```

然后重启（`dsh --profile web`）或让 HMR 重新装配。

### 装完怎么确认

```bash
dsh --profile web --dump-config | grep -n workspace-pins
```

能看到 `workspace-pins` 这一条就说明装配进来了；页面上侧边栏底部同时会出现图钉图标。

### 卸载

```bash
dsh plugin --profile web remove dsh-workspace-pins
```

再从 `dsh.profile.bundles` 数组和 `cordis.patch.yml` 里删掉上面那两处，重启即可。
插件的固定名单存在浏览器 `localStorage`（键 `dsh.workspace-pins.v1`），卸载后可以手动清掉。

## 使用教程

### 1. 固定一个工作区

点侧边栏底部的图钉按钮 → 面板列出全部工作区 → 点某行左侧的图钉。

固定项立刻升到列表最上面，**后固定的接在固定区末尾**（先固定的始终在上），
不会把先固定的那个顶下去。

### 2. 调整固定区里的先后

悬停固定项 → 右侧出现 `↑` `↓`，按需上下移动。固定区整体永远在所有未固定工作区之上。

### 3. 找不到工作区时

工作区超过 6 个，面板顶部会出现筛选框，按名字或路径过滤。

### 4. 永久删除一个工作区

悬停任意一行 → 最右侧出现垃圾桶 → 点击后底部弹出确认条：

> 永久删除「alpha」？它的 3 个会话记录会被一并删除，无法恢复（磁盘上的项目文件夹保留）。

确认后按顺序执行：归档该工作区名下的会话（正在运行的先停止）→ **删掉这些会话的记录文件** →
刷新会话列表 → 移除工作区注册。任何一步失败都会停下并把原因显示在面板上，不会留下
「工作区没了、对话还在」的半截状态。

**删的是对话记录，不是项目文件夹**：工作区目录里的源码和文件一个都不动。

### 5. 取消固定

再点一次图钉；「全部取消固定」一键还原。取消固定不影响工作区本身，也不会动它的会话。

## 为什么需要它

工作区一多，两个问题会同时出现：

1. 侧边栏要往下翻很久才能找到常用的那个；
2. 宿主的 `WorkspaceRegistry.create()` 是**把新工作区插到最前面**的（源码原话：
   "A newly created workspace is prepended to the durable registry order"），
   于是每新建一个文件夹，正在用的那几个就被往下挤一格。

## 它怎么解决

全部复用宿主已有能力，不新增任何业务状态、不改任何内置包：

| 步骤 | 用的东西 |
| --- | --- |
| 把固定项顶到最前 | 宿主已有的 `workspaces.insertBefore()`（DOM insertBefore 语义） |
| 记住固定了谁 | 浏览器 `localStorage`（键 `dsh.workspace-pins.v1`） |
| 入口 | 侧边栏底部的图钉按钮 + 本插件自己的浮层面板 |

顺序本身写进宿主的工作区注册表，所以**关掉页面后置顶依然有效**；下次打开页面会再校正一次
（比如页面关着的时候新建了工作区，它会被推回固定区之后）。

## 自检

不需要浏览器也能跑通骨架、排序与删除编排（用真实 `workspaces.insertBefore` / `archiveSession`
契约的模拟宿主 + React 桩）：

```bash
node test/client-selfcheck.mjs
```

覆盖：模块外壳与 slot 注册、6 种工作区布局下的收敛与写入次数、失效名单、组件渲染与写回、
删除链路（先归档 → 请求删日志 → 刷新 → 移除注册）、删除失败时不删注册。

## 结构

```
package.json         # bundle 声明 + dsh.client 声明 + engines.dsh
cordis.patch.yml     # 插入 workspace-pins 一行
index.js             # Host 半边：一个 POST 路由，真正删除会话日志目录
lib/client.js        # 客户端：顺序守卫 + 底部按钮 + 浮层面板 + 删除流程编排
locale/*.json        # 插件管理器里显示的标题/描述
icon.svg             # 插件图标
test/                # 离线自检
```

### 删除会话记录是怎么做到的

宿主没有「删除会话」的 API（`ISessions` 只有 create / fork / archive / refresh，
`WorkspaceRegistry.delete()` 也只移除注册），所以插件自己补了一条最小的宿主通道：

```
POST /dsh-workspace-pins/delete-sessions   { sessionIds: string[] }
```

它只做一件事：在会话根目录下按 `sessions/<项目目录>/session-<id>/` 找到该会话的目录并删除。
写死的三道约束：

- 会话 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`，杜绝路径穿越；单次最多 500 个；
- 删除路径只能是 `<root>/<项目目录>/session-<id>` 这一层，调用方传不了路径；
- 会话根目录优先取生效配置里 JSONL 后端的 `root`，读不到才退回 `~/.dsh/sessions`。

## 边界与已知取舍

- 固定名单存在**本机浏览器**，不跨设备同步；换浏览器要重新固定一次。
- 页面没打开时不跑顺序守卫，那期间新建的工作区会临时排在最前，下次打开页面自动归位。
- 与宿主自带的工作区拖拽排序不冲突：拖动固定区内的顺序会被下一次校正覆盖，请用面板里的
  ↑ ↓ 调整；拖动非固定区的工作区不受影响。
- **删除不可恢复**：删掉的是会话日志目录本身，确认条会写清受影响的会话数量。
- 搜索索引（SQLite）是缓存性质，删完文件后可能短暂残留命中项，宿主会自行对账；着急就重启一次。
- 改了 `index.js`（Host 半边）需要**禁用再启用一次这个插件条目**（或重启）才生效；
  改 `lib/client.js` 走 HMR，刷新即可。
- 归档时带 `stopActivity`：否则正在跑会话的工作区会被宿主拒绝归档，删完就掉进「未分组」继续跑。

## License

MIT
