# 工作区固定 · dsh-workspace-pins

给 DeepSeek WorkBuddy（dsh）侧边栏加一件事：**把常用的工作区钉在最上面，顺序不再乱。**

## 为什么需要它

工作区一多，两个问题会同时出现：

1. 侧边栏要往下翻很久才能找到常用的那个；
2. 宿主的 `WorkspaceRegistry.create()` 是**把新工作区插到最前面**的（源码里写着
   "A newly created workspace is prepended to the durable registry order"），
   于是每新建一个文件夹，正在用的那几个就被往下挤一格。

## 它怎么解决

只做两件事，全部复用宿主已有能力，**不新增任何 Host 状态、不改任何内置包**：

| 步骤 | 用的东西 |
| --- | --- |
| 把固定项顶到最前 | 宿主已有的 `workspaces.insertBefore()`（DOM insertBefore 语义） |
| 记住固定了谁 | 浏览器 `localStorage`（键 `dsh.workspace-pins.v1`） |
| 入口 | 侧边栏底部、设置旁边的图钉按钮 + 本插件自己的浮层面板 |

顺序本身写进宿主的工作区注册表，所以**关掉页面后置顶依然有效**；下次打开页面会再校正一次
（比如页面关着的时候新建了工作区，它会被推回固定区之后）。

## 用法

1. 点侧边栏底部的图钉按钮；
2. 在面板里点工作区左侧的图钉 → 固定（新固定的接在固定区**末尾**，先固定的始终在上）；
3. 固定项右侧的 ↑ ↓ 调整固定区内部的先后；
4. 工作区多于 6 个时，面板顶部出现筛选框；
5. 「全部取消固定」一键还原；
6. 每行悬停时最右侧是**删除**：二次确认后，先归档它名下的会话（正在运行的会先停止），
   再把工作区从侧边栏移除，并同步从固定名单里清掉。

固定区之后的工作区保持宿主自己的顺序（新建的仍会出现在固定区下面第一位）。

## 安装

本目录已经通过宿主的 `plugin_manager`（`install_bundle`）装进 `web` profile：

- 依赖写成 `link:D:/dsh-p/dsh-workspace-pins`（本仓库根目录），改这里的文件会走 HMR，不用重装；
- profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里多一行：

  ```yaml
  - insert:
      - id: workspace-pins
        name: dsh-workspace-pins
  ```

换机器 / 换 profile 时，用插件管理器的「从本地目录安装」指向本仓库根目录即可（会自动写上面这两处）。

> 从 GitHub clone 后安装时，目录名保持 `dsh-workspace-pins` 即可，`package.json` 的 `name` 才是真正的标识。

## 自检

不需要浏览器也能跑通骨架与排序逻辑（用的是真实 `workspaces.insertBefore` 契约的模拟宿主）：

```bash
node test/client-selfcheck.mjs
```

覆盖：模块外壳、服务注入、两个 slot 注册、顺序守卫在 6 种工作区布局下的收敛与写入次数、
失效名单（工作区已删除）、以及组件渲染与写回 localStorage。

## 结构

```
package.json         # bundle + dsh.client 声明
cordis.patch.yml     # 插入 workspace-pins 一行
index.js             # Host 半边：空逻辑，只为本包在 cordis 树上占一行
lib/client.js        # 全部功能：顺序守卫 + 底部按钮 + 浮层面板
locale/*.json        # 插件管理器里显示的标题/描述
icon.svg             # 插件图标
```

## 边界与已知取舍

- 固定名单存在**本机浏览器**，不跨设备同步；换浏览器要重新固定一次。
- 页面没打开时不跑守卫，所以那时新建的工作区会临时排在最前，下次打开页面自动归位。
- 与宿主自带的工作区拖拽排序不冲突：拖动固定区内的顺序会被下一次校正覆盖，请用面板里的
  ↑ ↓ 调整；拖动非固定区的工作区不受影响。
- **删除不删磁盘文件**：宿主只提供「移除注册」，所以插件做的是「归档该工作区的会话 + 移除注册」，
  文件夹原样保留。会话归档后可恢复；工作区想回来，重新「添加工作区」指向同一目录即可。
- 归档带 `stopActivity`：否则正在跑会话的工作区会被宿主拒绝归档，删完就掉进「未分组」继续跑。
- 所有失败路径都是 fail-open：拿不到服务、读不到存储、宿主拒绝写入时，什么都不做，
  侧边栏保持原样。

## License

MIT
