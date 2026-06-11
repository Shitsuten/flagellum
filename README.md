# flagellum

一个最小的流式 tool loop,演示一件事:**内置工具(built-in tools)**。

当网关和工具住在同一台你自己的机器上、服务的是同一个人时,模型调 `exec`(跑 shell 命令)和 `recall`(查长期记忆)可以直接在网关进程内执行——不需要 MCP,不需要协议往返,不需要再开一个服务。MCP 是用来够到**不属于你的**工具的;自己机器上的东西,不用绕那个圈。

这是从一个长期运行的个人助手部署里抽出来的,人格和关系内容都剥掉了,剩下的就是这一层管道。对话持久化、prompt 缓存断点布局、分层记忆系统不在这个仓库里——那些见 [paramecium](https://github.com/Shitsuten/paramecium)。

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

## ⚠️ 安全

`exec` 就是任意命令执行,以网关进程的身份跑。这个东西的设计前提是:**私有主机、有认证、单个受信任的用户**。绝对不要把它裸露在公网上,也不要给不受信任的调用方。服务器默认只绑 `127.0.0.1`。

## License

MIT
