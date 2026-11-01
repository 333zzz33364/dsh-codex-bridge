# dsh-codex-bridge

借本机 **Codex 的 ChatGPT 登录身份**出图，并在设置页显示订阅额度。不需要任何 API Key。

## 它做什么

| 工具 | 作用 |
|---|---|
| `codex_image` | 调 codex 内置的 `image_gen` 画一张图，图直接显示在对话里 |
| `codex_quota` | 查 5 小时窗口 / 每周窗口用量、重置时间、重置卡张数 |

设置页里还有一个「19. Codex 生图」面板，显示同样的额度，并管理开关、默认画幅、超时、代理等。

## 为什么不是又一套 API Key

Codex 在 ChatGPT 登录模式下自带 `image_gen` 工具，走的是订阅额度，不是 API 计费。
身份在 `~/.codex/auth.json`（`access_token` + `account_id`），本插件直接读它，配置里不存任何密钥。

额度接口就是 codex 自己用的那个：`GET https://chatgpt.com/backend-api/wham/usage`，几百字节，不消耗模型 token。

## 省 token

默认跑一次 codex 出图约 7.8 万 token。本插件打开了四个开关，实测降到 **4.5 万（-42%）**，画质不变：

| 开关 | 作用 |
|---|---|
| `-c model_verbosity="low"` | 少说废话 |
| `-c model_reasoning_effort="low"` | 少绕弯 |
| `-c tools.web_search=false` | 去掉用不上的联网工具定义 |
| `-c project_doc_max_bytes=0` | 不把 AGENTS.md 注入进去 |

再加一条「只做一件事」的提示词，把轮数压到最少。

## 已知限制

1. **慢**：一张 30–60 秒，因为本质上跑了一次完整的 agent 会话。
2. **独占**：codex 同时只能跑一个会话，插件里加了锁，并发调用会直接返回「上一张还在画」。
3. **吃订阅额度**：约每张 1% 的 5 小时窗口。
4. 聊天里点停止会把 codex 子进程杀掉，不会留孤儿进程。

## 安装

1. 本目录链接进 profile 的 `node_modules`：

   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\desktop
   # package.json 的 dependencies 加一行 "dsh-codex-bridge": "link:D:/aiz/聊天插件等/工具/插件/dsh-codex-bridge"
   # 再把 dsh-codex-bridge 加进 dsh.profile.bundles
   pnpm install
   ```

2. 重启 dsh（或重载 desktop profile），设置页里会出现「19. Codex 生图」。

## 自检

```powershell
node scripts/smoke.mjs            # 只查额度，不花 token
node scripts/smoke.mjs --image    # 连出图一起测（会消耗订阅额度）
```

上次运行的 codex 原始输出留在 `<DSH_HOME>/codex-bridge/outputs/work/last-run.log`，出问题时先看它。

## 目录

```
<DSH_HOME>/codex-bridge/
  config.json      插件配置（无密钥）
  outputs/YYYY-MM/ 生成的图
  outputs/work/    codex 的工作目录 + last-run.log
```
