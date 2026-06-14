# flagellum

一个最小的流式 tool loop,演示一件事:**内置工具(built-in tools)**。

当网关和工具住在同一台你自己的机器上、服务的是同一个人时,模型调 `exec`(跑 shell 命令)和 `recall`(查长期记忆)可以直接在网关进程内执行——不需要 MCP,不需要协议往返,不需要再开一个服务。MCP 是用来够到**不属于你的**工具的;自己机器上的东西,不用绕那个圈。

这是从一个长期运行的个人助手部署里抽出来的,人格和关系内容都剥掉了,剩下的就是这一层管道。对话持久化、prompt 缓存断点布局、分层记忆系统不在这个仓库里——那些见 [paramecium](https://github.com/Shitsuten/paramecium)。

## ⚠️ 安全

**这套工具(exec/recall)是备用紧急方案,不是日常方案。** 适用场景:官方 API 被封号、梯子挂了登录不上、需要临时让 AI 帮忙修服务器。不建议长期使用,原因有二:一是安全——即便加了以下所有防护,exec 的命令和输出仍然经过第三方;二是成本——编程任务带 tools 的 token 消耗大,走官方 key 或 OR 会很烧钱。日常对话和编程请用 Claude Code 或其他不经过中转站的可信客户端。

`exec` 就是任意命令执行。我们自己用中转站时踩过坑——exec 的命令和输出**经过中转站明文可见**,SSH 配置、文件列表、服务器拓扑全暴露了。以下是踩完坑后的安全分级:

### 前提:选对你的 API 通道

使用这些工具时,建议通过**官方 Anthropic API 直连**或 **OpenRouter** 这类有商业信誉的大型中转站。大站偷看用户数据的代价是毁灭性的(整个商业模式崩溃),小站没有这个约束。**即便如此,仍然建议加上以下所有防护措施**——信任中转站不等于把门打开。

### 前端工具开关

建议前端加一个工具总开关——关掉后发给 API 的请求不带 `tools` 字段,模型变成纯聊天模式。用途:当你从官方 API / OR 切换到其他中转站继续聊天时,一键关掉工具,避免模型根据上下文自动调用 exec 并将命令和输出暴露给不受信任的中转站。开关只控制请求里有没有 tools,不影响对话内容和记忆。

### 最安全:不用 exec

把常用操作拆成独立工具(类似 MCP,但可以是进程内的):

```js
// 替代 exec curl 127.0.0.1:3300/health
{ name: 'health_check', handler: () => fetch('http://127.0.0.1:3300/health').then(r => r.text()) }
// 替代 exec pm2 restart marginalia  
{ name: 'service_restart', handler: ({service}) => execShell('pm2 restart ' + service, ...) }
```

模型调用的是结构化工具,中转站看到的只是 `health_check()`,看不到端口号和命令行。服务多了会占 tool definition token,权衡取舍。

### 次安全:用 exec 但降权

如果需要保留 exec 的灵活性,**必须降权到独立用户**:

```bash
# 创建沙箱用户
useradd -r -s /bin/bash -m execuser
# ubuntu 可以免密切换到 execuser
echo "ubuntu ALL=(execuser) NOPASSWD: ALL" > /etc/sudoers.d/execuser
# 锁住敏感文件
chmod 600 ~/.ssh/* models.json .env
chmod 750 ~
```

然后设环境变量 `EXEC_USER=execuser`,tools.mjs 会自动用 `sudo -u execuser` 跑所有命令。execuser 读不了你的 SSH 密钥、API key、网关源码——Linux 文件权限硬挡,不靠正则。

### 兜底:输出脱敏(不管哪种方案都要加)

即便拆成了独立工具,服务返回的内容本身可能含敏感信息(比如日志里打了 IP,记忆库里存了配置)。`sanitizeOutput()` 在 tools.mjs 里自动洗:

- IP 地址 → `[IP]`
- 家目录路径 → `/home/[USER]`
- SSH 配置 → `[REDACTED]`  
- API key 模式 (sk-/wrk-/token-) → `[KEY]`
- 环境变量赋值 → `[ENV_VAR]`

这层正则是最后一道防线——权限没锁住的文件,脱敏接着拦。

### 跨服务器 SSH

如果需要 exec 连到另一台机器(比如修远程服务),**不要复用主用户的 SSH 密钥**:

1. 给 execuser 单独生成密钥: `sudo -u execuser ssh-keygen`
2. 远程机器创建低权限维修工用户: `useradd mechanic`
3. mechanic 只能查日志/重启服务,不能读配置
4. 公钥加到 mechanic 的 authorized_keys

三层降权:中转站 → execuser(沙箱) → mechanic(维修工)。

服务器默认只绑 `127.0.0.1`。

## 它怎么工作

```
客户端 ── POST /chat ──> server.mjs(无状态)
                            │
                        gateway.mjs
                            │
              ┌── 流式请求 Anthropic API,SSE 原样透传给客户端,
              │   同时在本端攒出完整的 content blocks
              │
              └── stop_reason == "tool_use" 时:
                    ├── exec / recall  → 进程内直接执行(tools.mjs)
                    ├── 其他名字       → fall through 到 MCP(mcp.mjs)
                    └── 结果塞回对话,发起下一轮,直到模型正常收尾
```

四个文件,各管一段:

| 文件 | 职责 |
|------|------|
| `tools.mjs` | 两个内置工具的定义和执行 |
| `mcp.mjs` | 最小 MCP 客户端,只做 fall-through |
| `gateway.mjs` | 流式透传 + tool loop |
| `server.mjs` | 无状态 demo 服务器 |

## 内置工具

**`exec`** — 在网关所在的主机上跑 shell 命令。60 秒超时,输出超过 8000 字符截断,工作目录由 `EXEC_CWD` 指定。

**`recall`** — 查长期记忆。语义检索是默认模式;`exact=true` 走逐字全文检索(FTS),适合找原话。它代理到一个本地记忆服务(`MEMORY_URL`,默认 `127.0.0.1:3900`),接口约定:

```
POST /search       { query, n }  →  { results: [{ document, metadata: { date, category } }] }
POST /raw-search   { query, n }  →  { results: [{ content, date, source, role }] }
```

记忆服务本体不在这个仓库——任何实现了这两个端点的服务都能接上,参考实现见 paramecium。没有记忆服务时 recall 会优雅地报错,不影响 exec 和正常对话。

## 为什么不全走 MCP

1. **没有协议往返。** MCP 每次调用是 initialize → tools/list → tools/call 三段 JSON-RPC;内置工具就是一次函数调用。
2. **工具定义字节级稳定。** 工具定义排在 prompt 缓存前缀的最前面,内置工具的定义写死在代码里、顺序固定,永远不会因为某个 MCP 服务抖动而打破整条缓存前缀。
3. **两者共存,不用二选一。** 模型调了内置工具不认识的名字,自动 fall through 到 MCP。远程服务照常接 MCP,本机的事情进程内做。

## exec 是万能撬锁片,但它需要一张地图

放弃 MCP 的同时也放弃了它的 schema:模型拿到 exec 之后什么门都能试着开,但端口号、endpoint 路径、认证方式得自己知道。没有 schema 兜底,错了就是 400 或者静默失败——要么模型每次先跑一轮 `grep` 去查(多一整轮工具往返,我们的 504 postmortem 里那次事故恰好就是被一次查端口的 grep 触发的),要么环境知识得放在一个它天生就看得见的地方。

试过的选项和结论:

- **工具 description 里** ✗ — 工具定义是 prompt 缓存前缀的字节级稳定开头,不该混进会变的数据
- **长期记忆里** ✗ — 基础设施事实不是记忆,语义检索对"3300是谁"这种查表问题不可靠
- **机器上放一个 SERVICE.md 靠 exec 去 grep** △ — 可以,但常用查询每次多一轮往返
- **system prompt 的稳定缓存段里放一个紧凑表** ✓ — 十几个服务一行一个,两三百 token,挂在带 `cache_control` 的前缀块里几乎免费,模型张口就知道

```
<server_map>
本机服务,直接 curl 127.0.0.1:端口
3800 chat-api — 你自己所在的网关
3900 mem-search — 记忆引擎(/inject /search)
3500 whisper — 语音+推送
…
端点详情/认证方式: grep /opt/SERVICE.md
</server_map>
```

经验法则:**prompt 块管"哪个端口"这类高频小事实,机器上的详情文档管长尾**——表的最后一行给模型指路,需要 nginx 路由、token 这种细节时它自己会去 grep。实测效果:同一个问题,改造前是一轮 grep 加一次工具往返,改造后零工具调用直接报答案。

## 运行

需要 Node 18+,没有任何 npm 依赖。

```bash
ANTHROPIC_API_KEY=sk-ant-... \
EXEC_CWD=/home/youruser \
node server.mjs
```

监听 `127.0.0.1:3800`。可选环境变量:

- `MEMORY_URL` — recall 代理的记忆服务地址,默认 `http://127.0.0.1:3900`
- `MCP_SERVERS` — 每行一个 streamable-http 端点 URL,留空则只有内置工具
- `ANTHROPIC_BASE_URL` — 换 API 端点(代理等),默认官方 `/v1/messages`
- `PORT` — 默认 3800

试一下:

```bash
curl -N http://127.0.0.1:3800/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"看一下这台机器的磁盘还剩多少"}]}'
```

响应是 Anthropic 格式的 SSE 流,外加一种自定义事件 `gateway_tool_result`(工具执行结果,方便客户端实时渲染;按标准格式解析的客户端会自动忽略它)。流空闲超过 14 秒时会发 `: ping` 注释帧保活,SSE parser 会自动忽略。

## 放在反向代理后面

这一节是用一个真实的 504 换来的——完整的踩坑记录见 [POSTMORTEM.md](POSTMORTEM.md),这套东西发布当晚就在生产环境翻了车,值得一读。

工具执行期间(exec 最长能跑 60 秒)SSE 流上**一个字节都没有**,而 nginx 的 `proxy_read_timeout` 默认正好也是 60 秒,Cloudflare 的空闲超时约 100 秒——一条慢命令就能让代理在网关还在干活的时候把连接掐掉,客户端看到 504,网关这边毫无知觉。

网关侧的根治是上面说的空闲保活 ping(任何长度的工具执行,静默都不会超过 ~19 秒)。代理侧配合两件事:

```nginx
location /chat {
    proxy_pass http://127.0.0.1:3800;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;            # SSE 必须关 buffering,否则 ping 也救不了
    proxy_read_timeout 600s;        # tool loop 可以合法地跑几分钟
}
```

另外所有出网关的 fetch(recall 的记忆服务、MCP 握手)都带 `AbortSignal.timeout`:MCP 握手发生在响应头写出之前,一个挂死的依赖服务会把整个请求堵在 `writeHead` 前面——那是 ping 都救不了的死法,只能靠超时降级。

## License

MIT
