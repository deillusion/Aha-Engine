import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// Read-only proxy discovery. Re-evaluated for every request so switching Windows proxies
// does not require editing the application. VARINA_PROXY_URL=direct explicitly bypasses it.
export async function proxyFor(target) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return null;
  const bypass = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (bypass.some(s => s === '*' || target.hostname === s || (s.startsWith('.') && target.hostname.endsWith(s)))) return null;
  const explicit = process.env.VARINA_PROXY_URL ?? process.env.AHA_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (explicit) return explicit === 'direct' ? null : new URL(explicit);
  if (process.platform === 'win32') {
    try {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; if($p.ProxyEnable -eq 1){$p.ProxyServer}"], { windowsHide: true, timeout: 3000 });
      let address = stdout.trim();
      if (address.includes('=')) address = address.split(';').find(x => x.startsWith('https='))?.slice(6) ?? address.split(';').find(x => x.startsWith('http='))?.slice(5) ?? '';
      if (address) return new URL(address.includes('://') ? address : `http://${address}`);
    } catch { /* No readable system proxy: use a direct connection. */ }
  }
  return null;
}
function tunnel(target, proxy, signal) {
  return new Promise((resolve, reject) => {
    const client = proxy.protocol === 'https:' ? https : http;
    const authorization = proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : null;
    const request = client.request({ hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${target.hostname}:${target.port || 443}`, headers: { Host: `${target.hostname}:${target.port || 443}`, ...(authorization ? { 'Proxy-Authorization': authorization } : {}) }, signal });
    request.once('error', reject);
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); return reject(new Error(`代理 CONNECT 失败：HTTP ${response.statusCode}`)); }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
      const abort = () => secure.destroy(new Error('连接已取消')); signal?.addEventListener('abort', abort, { once: true });
      secure.once('error', reject);
      secure.once('secureConnect', () => { signal?.removeEventListener('abort', abort); resolve(secure); });
    });
    request.end();
  });
}
export async function postJSON(url, payload, headers, { signal, proxy: specifiedProxy } = {}) {
  const target = new URL(url), proxy = specifiedProxy === undefined ? await proxyFor(target) : specifiedProxy;
  signal?.throwIfAborted();
  if (proxy && !['http:', 'https:'].includes(proxy.protocol)) throw new Error('仅支持 HTTP(S) 代理；请使用代理软件的 HTTP/Mixed 端口或 TUN 模式');
  let socket, agent;
  if (proxy && target.protocol === 'https:') {
    socket = await tunnel(target, proxy, signal);
    agent = new https.Agent({ keepAlive: false }); agent.createConnection = () => socket;
  }
  const data = Buffer.from(JSON.stringify(payload));
  return await new Promise((resolve, reject) => {
    const plainProxy = proxy && target.protocol === 'http:';
    const auth = plainProxy && proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {};
    const client = plainProxy ? (proxy.protocol === 'https:' ? https : http) : (target.protocol === 'https:' ? https : http);
    const request = client.request({ hostname: plainProxy ? proxy.hostname : target.hostname, port: plainProxy ? proxy.port || (proxy.protocol === 'https:' ? 443 : 80) : target.port || (target.protocol === 'https:' ? 443 : 80), path: plainProxy ? target.href : `${target.pathname}${target.search}`, method: 'POST', headers: { Host: target.host, ...headers, ...auth, 'Content-Length': data.length }, agent, signal }, response => {
      if (response.statusCode !== 200) {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size <= 16384) chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          let error = null;
          if (size <= 16384) { try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); error = value.error ?? null; } catch { /* Do not expose arbitrary HTML response bodies. */ } }
          resolve({ ok: false, status: response.statusCode, error });
        });
        return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) response.destroy(new Error('模型响应超过32MB')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try { resolve({ ok: true, status: 200, data: JSON.parse(Buffer.concat(chunks).toString('utf8')), requestId: response.headers['x-request-id'] ?? null }); } catch { reject(new Error('模型服务返回了无效 JSON 响应')); } });
    });
    request.on('error', reject); request.end(data);
  }).finally(() => { agent?.destroy(); socket?.destroy(); });
}
