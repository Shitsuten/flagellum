# Postmortem:上线当晚的 504

2026-06-11。这套 tool loop 从生产部署里抽出来、发到这个 repo 的同一个晚上,生产环境就翻车了。正常聊了两轮,第三轮模型去 grep 一个文件,客户端收到一页 nginx 的 504 Gateway Time-out。

值得写下来,因为**翻车的原因不在这个 repo 的任何一行逻辑里**——repo 发布时的代码逻辑是对的,它死于自己改变了流量的时间形状。

## 症状

- 前两轮工具调用完全正常(exec 跑 `uptime`、`pm2 ls`,秒回)
- 第三轮突然 504,返回的是 nginx 的 HTML 错误页,不是网关的 SSE error 事件
- 网关日志里看不到任何报错——它甚至不知道连接已经没了,还在认真干活

"正常 N 轮然后突然崩"这个形状本身就是签名:逻辑错误从第一轮就会错,**时间形状的错误要等流量变慢才现身**。前两轮的命令都是毫秒级返回,第三轮赶上了慢的。

## 验尸

nginx 的 error log 里躺着两条记录,相隔三分半:

```
13:44:52 upstream timed out (110) while reading upstream,
         request: "POST /…/gateway/send", upstream: "http://127.0.0.1:3800/…"
13:48:22 upstream timed out (110) while reading response header from upstream,
         request: "POST /…/gateway/send", upstream: "http://127.0.0.1:3800/…"
```

措辞差五个词,是**两种完全不同的死法**:

### 死法一:`while reading upstream` — 流中间的静默

SSE 流已经开始,但超过 60 秒(nginx `proxy_read_timeout` 的默认值)没有新字节。

工具执行期间,流上一个字节都没有:模型停在 `tool_use`,网关去跑 exec,直到拿到结果发出 `gateway_tool_result` 事件之前,客户端方向是完全静默的。而 exec 自己的超时上限恰好也是 60 秒——一条慢命令,exec 还没到自己的上限,nginx 先开了枪。

对 nginx 来说,"健康但沉默"和"挂了"没有任何区别。

### 死法二:`while reading response header` — 响应头之前的堵塞

更隐蔽。连响应头都没发出去,60 秒就到了。

`handleChat` 在 `res.writeHead(200)` 之前要先 await 两件事:记忆注入(打记忆服务)和 MCP 工具列表(握手)。这两处的 fetch 当时**没有 timeout**。

那天晚上记忆服务正好处于最坏状态:它是 Python 单线程 `HTTPServer`,一个 cron 任务每十分钟灌一批 `/archive-ingest`(每个都要跑 embedding),交互路径的 `/inject` 排在批处理队伍后面干等。没有 timeout 的 fetch 就这么等着,headers 一直没写,nginx 数完 60 秒掐线。

讽刺的是这里 try/catch 和优雅降级的返回值都写了,设计意图完全正确——但 fetch 没有 timeout,**catch 永远等不到它该接的那个错误**。降级路径必须有东西负责触发它,不然就是一扇画在墙上的安全门。

## 修法

三层,缺一不可:

**1. 网关:空闲守卫保活**(`gateway.mjs`)

静默超过 14 秒就发一帧 `: ping` SSE 注释。不是无脑 `setInterval` 直接发——proxyStream 在透传上游的原始 chunk,event 可能被 TCP 拆在两个 chunk 里,盲发的 ping 有概率插进半个 event 中间污染流。所以包一层 `res.write` 记录最后写入时间,只在真正空闲时发:

```js
const origWrite = res.write.bind(res);
let lastWrite = Date.now();
res.write = (...a) => { lastWrite = Date.now(); return origWrite(...a); };
const pingTimer = setInterval(() => {
  if (!res.writableEnded && Date.now() - lastWrite > 14000) res.write(': ping\n\n');
}, 5000);
res.once('close', () => clearInterval(pingTimer));
```

这条同时治 nginx(60s)和 Cloudflare(~100s)两层的空闲超时:任何长度的工具执行,静默都不会超过 ~19 秒。

**2. 所有出网关的 fetch:超时降级**(`tools.mjs` / `mcp.mjs`)

`AbortSignal.timeout()` 全部带上——记忆服务 10s,MCP 握手 8s,MCP 工具调用 60s(和 exec 对齐)。写在 writeHead 之前的依赖调用尤其没有借口:那个位置挂死,连 ping 都救不了。

**3. 代理:把默认值改成有意识的值**(README 的反向代理一节)

`proxy_read_timeout 600s` + `proxy_buffering off`。tool loop 跑几分钟是合法行为,不该用一个为普通 HTTP 请求设计的默认值去裁判它。

顺手把那个单线程记忆服务换成了 `ThreadingHTTPServer`(它的 DB 访问本来就是每请求新开连接,换了就能用),批处理和交互路径不再共用一条队列。

## 验证

修完之后的两次实测,都从公网穿 Cloudflare + nginx 全链路:

- 让模型 exec `sleep 59`:**81 秒,HTTP 200**,静默窗口里数到 3 帧 `: ping`,两轮收尾干净
- 压力测试三连:`sleep 70`(故意撞 exec 的 60s 上限被杀)+ 五千行输出(8000 字符截断)+ 一次 recall:**100.8 秒,四轮 tool loop,HTTP 200**

修复前,这两条请求会在 60 秒处死在三个不同的位置。

## 教训

1. **时间是接口的一部分。** 代码逻辑不变,只改变字节在连接上出现的节奏,就足以触发故障。审一个架构改动时,除了"数据对不对",还要问"安静的窗口有多长,谁在给这个窗口计时"。
2. **长连接要自己证明自己活着。** 凡是穿过你控制不了的中间层(代理、CDN、运营商)的流,保活不是装饰。
3. **错误信息的措辞就是验尸报告。** `reading response header` 和 `reading upstream` 指向两个根因,只看见"504"两个字就去调超时,会留一个埋着。
4. **没有 timeout 的 fetch,旁边的 catch 是装饰品。** 降级逻辑的触发器和降级逻辑本身一样重要。
5. **超时是一层一层的墙。** 这次修到 nginx 为止,但客户端 app 自己还有一层请求超时——哪天服务端日志干干净净而 app 报超时,先查那里。

刚完工就出 bug 不丢人。丢人的是同一个 bug 摔两次——所以有了这份文档。
