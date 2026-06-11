// ============================================================
//  最小 demo 服务器 — 无状态,POST /chat 进来跑一次 tool loop。
//  对话持久化、缓存布局这些不归 flagellum 管(见 paramecium)。
// ============================================================

import http from 'http';
import { handleChat } from './gateway.mjs';

const PORT = process.env.PORT || 3800;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid json"}');
        return;
      }
      handleChat(parsed, res).catch(e => {
        console.error('[server]', e.message);
        try { res.end(); } catch {}
      });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`flagellum listening on 127.0.0.1:${PORT}`);
});
