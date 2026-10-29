#!/usr/bin/env node
// http-inspect: a local reverse proxy that records every request Claude Code
// sends to the model API, and every chunk of every response, to disk.
//
// Usage: http-inspect <command>
//   serve            Run the proxy in the foreground.
//   start            Start the proxy in the background (no-op if it runs).
//   stop             Stop the background proxy.
//   status           Show the proxy state and the setup.
//   run [args...]    Start the proxy, then run `claude` through it.
//   list [n]         List the last n captured exchanges (default 20).
//   show [id|last]   Show one exchange: request summary and reassembled reply.
//   path [id|last]   Print the folder of one exchange.
//   hook-session-start   SessionStart hook entry point.
//
// Environment:
//   HTTP_INSPECT_PORT       Listen port (default 8790).
//   HTTP_INSPECT_DIR        Capture folder (default ~/.claude/http-inspect).
//   HTTP_INSPECT_UPSTREAM   Real API base URL (default: the ANTHROPIC_BASE_URL
//                           that was set before the proxy, else
//                           https://api.anthropic.com).
//   HTTP_INSPECT_REDACT     0 keeps auth headers in the capture (default 1).
//   HTTP_INSPECT_KEEP_ENCODING  1 forwards Accept-Encoding as sent. The default
//                           asks the API for an uncompressed reply, so that the
//                           chunks are readable.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PORT = Number(process.env.HTTP_INSPECT_PORT || 8790);
const HOST = '127.0.0.1';
const DIR = process.env.HTTP_INSPECT_DIR || path.join(os.homedir(), '.claude', 'http-inspect');
const CAPTURES = path.join(DIR, 'captures');
const INDEX = path.join(DIR, 'index.jsonl');
const STATE = path.join(DIR, 'proxy.json');
const LOG = path.join(DIR, 'proxy.log');
const REDACT = process.env.HTTP_INSPECT_REDACT !== '0';
const KEEP_ENCODING = process.env.HTTP_INSPECT_KEEP_ENCODING === '1';
const PROXY_URL = `http://${HOST}:${PORT}`;

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'proxy-authorization']);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate',
]);

// ---------------------------------------------------------------- helpers

function isSelf(u) {
  try {
    const p = new URL(u);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname) && Number(p.port || 80) === PORT;
  } catch {
    return false;
  }
}

function upstreamBase() {
  const candidates = [process.env.HTTP_INSPECT_UPSTREAM, process.env.ANTHROPIC_BASE_URL];
  for (const c of candidates) if (c && !isSelf(c)) return c.replace(/\/+$/, '');
  return 'https://api.anthropic.com';
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REDACT && SECRET_HEADERS.has(k.toLowerCase())) {
      const s = String(v);
      out[k] = `<redacted ${s.length} chars, ends "${s.slice(-4)}">`;
    } else out[k] = v;
  }
  return out;
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readState() {
  return tryJson(fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '') || null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${PROXY_URL}/__http_inspect/health`, { timeout: 500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 ? tryJson(body) || {} : null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

// NO_PROXY matching: exact host, ".suffix", "*.suffix", or "*".
function bypassProxy(host) {
  const list = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.some((e) => {
    if (e === '*') return true;
    const bare = e.replace(/^\*?\./, '');
    return host === bare || host.endsWith('.' + bare);
  });
}

// Open a request to the upstream. For an https upstream behind HTTPS_PROXY,
// open a CONNECT tunnel first, because node:https does not read the proxy env.
function upstreamRequest(target, options, onReady) {
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = Number(target.port || (isHttps ? 443 : 80));
  const proxy = isHttps && (process.env.HTTPS_PROXY || process.env.https_proxy);
  const base = { ...options, hostname: target.hostname, port, path: target.pathname + target.search };
  if (!proxy || bypassProxy(target.hostname)) return onReady(null, lib.request(base));

  const p = new URL(proxy);
  const headers = { host: `${target.hostname}:${port}` };
  if (p.username) headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
  const connect = http.request({ hostname: p.hostname, port: Number(p.port || 80), method: 'CONNECT', path: headers.host, headers });
  connect.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      return onReady(new Error(`proxy CONNECT failed: ${res.statusCode}`));
    }
    const req = https.request({
      ...base,
      agent: false,
      createConnection: () => tls.connect({ socket, servername: target.hostname }),
    });
    onReady(null, req);
  });
  connect.on('error', (err) => onReady(err));
  connect.end();
}

// Incremental SSE parser. Calls onEvent({event, data, raw}) for each event.
function sseParser(onEvent) {
  let buf = '';
  return (text) => {
    buf += text;
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length && event === 'message') continue;
      const joined = data.join('\n');
      const parsed = tryJson(joined);
      onEvent({ event, data: parsed === undefined ? joined : parsed });
    }
  };
}

// ---------------------------------------------------------------- proxy

let seq = 0;

function targetFor(reqUrl) {
  const base = upstreamBase();
  return new URL(new URL(base).pathname.replace(/\/+$/, '') + reqUrl, base);
}

// WebSocket and other upgrades: pass the bytes through both ways, and record
// only the handshake in the index. The frames are not captured.
function handleUpgrade(req, socket, head) {
  const target = targetFor(req.url);
  const headers = { ...req.headers, host: target.host };
  const writeHead = (code, msg, raw) => {
    let out = `HTTP/1.1 ${code} ${msg}\r\n`;
    for (let i = 0; i < raw.length; i += 2) out += `${raw[i]}: ${raw[i + 1]}\r\n`;
    socket.write(out + '\r\n');
  };
  const note = (status, error) => {
    const id = `${stamp()}-${String(++seq).padStart(4, '0')}`;
    fs.appendFileSync(INDEX, JSON.stringify({ id, startedAt: new Date().toISOString(), method: req.method, path: req.url, status, upgrade: req.headers.upgrade, chunks: 0, totalMs: 0, error }) + '\n');
    log(`${id} UPGRADE ${req.url} -> ${status ?? 'ERR'}${error ? ' ' + error : ''}`);
  };
  socket.on('error', () => {});
  upstreamRequest(target, { method: req.method, headers }, (err, up) => {
    if (err) {
      note(null, err.message);
      return socket.destroy();
    }
    up.on('upgrade', (ur, us, uh) => {
      note(ur.statusCode);
      writeHead(ur.statusCode, ur.statusMessage, ur.rawHeaders);
      if (uh.length) socket.write(uh);
      if (head.length) us.write(head);
      us.on('error', () => socket.destroy());
      socket.on('close', () => us.destroy());
      us.pipe(socket).pipe(us);
    });
    up.on('response', (ur) => {
      note(ur.statusCode);
      writeHead(ur.statusCode, ur.statusMessage, ur.rawHeaders);
      ur.pipe(socket);
    });
    up.on('error', (e) => {
      note(null, e.message);
      socket.destroy();
    });
    up.end();
  });
}

function handle(req, res) {
  if (req.url === '/__http_inspect/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ pid: process.pid, port: PORT, upstream: upstreamBase(), dir: DIR }));
  }

  const t0 = performance.now();
  const startedAt = new Date();
  const id = `${stamp(startedAt)}-${String(++seq).padStart(4, '0')}`;
  const dir = path.join(CAPTURES, id);
  fs.mkdirSync(dir, { recursive: true });

  const bodyParts = [];
  req.on('data', (c) => bodyParts.push(c));
  req.on('end', () => {
    const body = Buffer.concat(bodyParts);
    const target = targetFor(req.url);

    const fwd = {};
    const changed = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k)) fwd[k] = v;
    fwd.host = target.host;
    if (!KEEP_ENCODING && fwd['accept-encoding'] && fwd['accept-encoding'] !== 'identity') {
      changed['accept-encoding'] = { sent: fwd['accept-encoding'], forwarded: 'identity' };
      fwd['accept-encoding'] = 'identity';
    }

    const json = tryJson(body.toString('utf8'));
    fs.writeFileSync(path.join(dir, 'request.body'), body);
    if (json !== undefined) writeJson(path.join(dir, 'request.body.json'), json);
    const reqMeta = {
      id,
      startedAt: startedAt.toISOString(),
      method: req.method,
      path: req.url,
      upstream: target.toString(),
      httpVersion: req.httpVersion,
      headers: redactHeaders(req.headers),
      rawHeaders: REDACT ? undefined : req.rawHeaders,
      headerChangesOnForward: changed,
      bodyBytes: body.length,
    };
    writeJson(path.join(dir, 'request.json'), reqMeta);

    const chunks = fs.createWriteStream(path.join(dir, 'chunks.jsonl'));
    const events = fs.createWriteStream(path.join(dir, 'events.jsonl'));
    const raw = fs.createWriteStream(path.join(dir, 'response.body'));
    const ms = () => Math.round((performance.now() - t0) * 1000) / 1000;
    let chunkSeq = 0;
    let eventSeq = 0;
    let bytes = 0;
    let firstByteMs = null;
    let status = null;
    let resHeaders = null;
    let done = false;
    const parse = sseParser((e) => events.write(JSON.stringify({ seq: ++eventSeq, t: ms(), ...e }) + '\n'));

    const finish = (error) => {
      if (done) return;
      done = true;
      const totalMs = ms();
      chunks.end();
      events.end();
      raw.end();
      writeJson(path.join(dir, 'response.json'), {
        status, headers: resHeaders, firstByteMs, totalMs, bytes, chunks: chunkSeq, sseEvents: eventSeq,
        error: error ? String(error.message || error) : undefined,
      });
      const entry = {
        id, startedAt: reqMeta.startedAt, method: req.method, path: req.url, status,
        model: json && json.model, stream: json && json.stream === true, totalMs, firstByteMs,
        reqBytes: body.length, resBytes: bytes, chunks: chunkSeq,
        session: req.headers['x-claude-code-session-id'], error: error ? String(error.message || error) : undefined,
      };
      fs.appendFileSync(INDEX, JSON.stringify(entry) + '\n');
      log(`${id} ${req.method} ${req.url} -> ${status ?? 'ERR'} ${totalMs}ms ${bytes}B ${chunkSeq} chunks`);
    };

    upstreamRequest(target, { method: req.method, headers: fwd }, (err, up) => {
      if (err) return fail(err);
      up.on('response', (ur) => {
        status = ur.statusCode;
        resHeaders = redactHeaders(ur.headers);
        const out = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP_HEADERS.has(k)) out[k] = v;
        res.writeHead(ur.statusCode, ur.statusMessage, out);
        res.flushHeaders();
        const isSse = String(ur.headers['content-type'] || '').includes('text/event-stream');
        ur.on('data', (c) => {
          if (firstByteMs === null) firstByteMs = ms();
          bytes += c.length;
          const text = c.toString('utf8');
          const line = { seq: ++chunkSeq, t: ms(), bytes: c.length, text };
          if (!Buffer.from(text, 'utf8').equals(c)) line.base64 = c.toString('base64');
          chunks.write(JSON.stringify(line) + '\n');
          raw.write(c);
          if (isSse) parse(text);
          res.write(c);
        });
        ur.on('end', () => {
          res.end();
          finish();
        });
        ur.on('error', (e) => {
          res.destroy(e);
          finish(e);
        });
      });
      up.on('error', fail);
      res.on('close', () => {
        if (!done && !res.writableFinished) {
          up.destroy();
          finish(new Error('client closed the connection'));
        }
      });
      up.end(body);
    });

    function fail(err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'http_inspect_proxy_error', message: String(err.message || err) } }));
      } else res.destroy(err);
      finish(err);
    }
  });
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
}

function serve() {
  fs.mkdirSync(CAPTURES, { recursive: true });
  const server = http.createServer(handle);
  server.on('upgrade', handleUpgrade);
  server.keepAliveTimeout = 120_000;
  server.on('error', (e) => {
    console.error(`http-inspect: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    writeJson(STATE, { pid: process.pid, port: PORT, upstream: upstreamBase(), dir: DIR, startedAt: new Date().toISOString() });
    log(`listening on ${PROXY_URL}, upstream ${upstreamBase()}, captures in ${CAPTURES}`);
  });
  const stop = () => {
    const s = readState();
    if (s && s.pid === process.pid) fs.rmSync(STATE, { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function start({ quiet = false } = {}) {
  const running = await ping();
  if (running) {
    if (!quiet) console.log(`http-inspect: already running on ${PROXY_URL} (pid ${running.pid})`);
    return running;
  }
  fs.mkdirSync(DIR, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [SELF, 'serve'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = await ping();
    if (s) {
      if (!quiet) console.log(`http-inspect: started on ${PROXY_URL} (pid ${s.pid}), upstream ${s.upstream}`);
      return s;
    }
  }
  throw new Error(`the proxy did not start, see ${LOG}`);
}

async function stop() {
  const s = (await ping()) || readState();
  if (!s || !alive(s.pid)) {
    fs.rmSync(STATE, { force: true });
    return console.log('http-inspect: not running');
  }
  process.kill(s.pid, 'SIGTERM');
  console.log(`http-inspect: stopped pid ${s.pid}`);
}

// ---------------------------------------------------------------- viewer

function readIndex() {
  if (!fs.existsSync(INDEX)) return [];
  return fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean).map(tryJson).filter(Boolean);
}

function resolveId(arg) {
  const all = readIndex();
  if (!all.length) throw new Error(`no captures yet in ${DIR}`);
  if (!arg || arg === 'last') return all[all.length - 1].id;
  if (/^-?\d+$/.test(arg) && Number(arg) <= 0) return all[all.length - 1 + Number(arg)].id;
  const hit = all.filter((e) => e.id.includes(arg));
  if (!hit.length) throw new Error(`no capture matches "${arg}"`);
  return hit[hit.length - 1].id;
}

function list(n = 20) {
  const all = readIndex().slice(-n);
  if (!all.length) return console.log(`No captures yet in ${DIR}`);
  for (const e of all) {
    console.log(
      [e.id, String(e.status ?? 'ERR').padEnd(3), (e.upgrade ? 'WS' : e.method).padEnd(4), e.path.padEnd(28), (e.model || '-').padEnd(26),
        e.stream ? 'sse' : '   ', `${Math.round(e.totalMs)}ms`.padStart(8), `${e.chunks} chunks`, e.error ? `! ${e.error}` : ''].join('  '),
    );
  }
  console.log(`\n${CAPTURES}`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(tryJson).filter(Boolean);
}

function clip(s, n = 400) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s;
}

function show(arg, { full = false } = {}) {
  const id = resolveId(arg);
  const dir = path.join(CAPTURES, id);
  const rq = tryJson(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  const rs = fs.existsSync(path.join(dir, 'response.json')) ? tryJson(fs.readFileSync(path.join(dir, 'response.json'), 'utf8')) : null;
  const body = fs.existsSync(path.join(dir, 'request.body.json')) ? tryJson(fs.readFileSync(path.join(dir, 'request.body.json'), 'utf8')) : null;
  const c = full ? Infinity : 400;

  console.log(`# ${id}\n${dir}\n`);
  console.log(`## Request\n${rq.method} ${rq.upstream}  (${rq.bodyBytes} bytes)`);
  for (const [k, v] of Object.entries(rq.headers)) console.log(`  ${k}: ${v}`);
  if (Object.keys(rq.headerChangesOnForward || {}).length) console.log(`  changed on forward: ${JSON.stringify(rq.headerChangesOnForward)}`);
  if (body && typeof body === 'object') {
    const { messages, system, tools, ...rest } = body;
    console.log(`\n  params: ${JSON.stringify(rest)}`);
    if (system) {
      const blocks = Array.isArray(system) ? system : [{ type: 'text', text: system }];
      console.log(`  system: ${blocks.length} block(s), ${blocks.reduce((a, b) => a + (b.text || '').length, 0)} chars`);
      for (const b of blocks) console.log(`    - ${clip(JSON.stringify(b.text ?? b), c)}${b.cache_control ? '  [cache_control]' : ''}`);
    }
    if (tools && tools.length) console.log(`  tools: ${tools.length}: ${tools.map((t) => t.name || t.type).join(', ')}`);
    if (messages) {
      console.log(`  messages: ${messages.length}`);
      for (const m of messages.slice(full ? 0 : -4)) {
        const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        for (const p of parts) {
          const v = p.type === 'text' ? p.text : p.type === 'tool_use' ? `${p.name} ${JSON.stringify(p.input)}` : p.type === 'tool_result' ? JSON.stringify(p.content) : p.type === 'thinking' ? p.thinking : JSON.stringify(p);
          console.log(`    ${m.role}/${p.type}: ${clip(v, c)}`);
        }
      }
      if (!full && messages.length > 4) console.log(`    (last 4 shown; use --full for all)`);
    }
  }

  if (!rs) return console.log('\n## Response\n(still in flight or the proxy stopped)');
  console.log(`\n## Response\n${rs.status}  first byte ${rs.firstByteMs}ms, total ${rs.totalMs}ms, ${rs.bytes} bytes, ${rs.chunks} chunks, ${rs.sseEvents} SSE events${rs.error ? `\n  error: ${rs.error}` : ''}`);
  for (const [k, v] of Object.entries(rs.headers || {})) console.log(`  ${k}: ${v}`);

  const events = readJsonl(path.join(dir, 'events.jsonl'));
  if (events.length) {
    const counts = {};
    for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1;
    console.log(`\n  events: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ')}`);
    const blocks = [];
    let usage = {};
    let stop = null;
    for (const { data: d, t } of events) {
      if (!d || typeof d !== 'object') continue;
      if (d.type === 'message_start') usage = { ...d.message.usage };
      if (d.type === 'content_block_start') blocks[d.index] = { ...d.content_block, _text: '', _t0: t };
      if (d.type === 'content_block_delta') {
        const b = blocks[d.index];
        const x = d.delta;
        b._text += x.text ?? x.thinking ?? x.partial_json ?? '';
        b._t1 = t;
      }
      if (d.type === 'message_delta') {
        usage = { ...usage, ...d.usage };
        stop = d.delta && d.delta.stop_reason;
      }
    }
    console.log(`  stop_reason: ${stop}  usage: ${JSON.stringify(usage)}`);
    blocks.forEach((b, i) => {
      if (!b) return;
      const label = b.type === 'tool_use' ? `tool_use ${b.name}` : b.type;
      console.log(`\n  [${i}] ${label}  (${b._t0}ms → ${b._t1 ?? b._t0}ms)\n${indent(clip(b._text || JSON.stringify(b), full ? Infinity : 2000))}`);
    });
  } else {
    const raw = fs.readFileSync(path.join(dir, 'response.body'), 'utf8');
    console.log(`\n${indent(clip(JSON.stringify(tryJson(raw) ?? raw, null, 2), full ? Infinity : 4000))}`);
  }
  console.log(`\nFiles: request.json request.body(.json) response.json chunks.jsonl events.jsonl response.body`);
}

function indent(s) {
  return s.split('\n').map((l) => '    ' + l).join('\n');
}

// ---------------------------------------------------------------- commands

async function status() {
  const s = await ping();
  const base = process.env.ANTHROPIC_BASE_URL;
  console.log(s ? `proxy: running on ${PROXY_URL} (pid ${s.pid}), upstream ${s.upstream}` : `proxy: not running (port ${PORT})`);
  console.log(`captures: ${CAPTURES} (${readIndex().length} exchanges)`);
  console.log(isSelf(base || '')
    ? 'this session: ANTHROPIC_BASE_URL points at the proxy, so its traffic is captured'
    : `this session: ANTHROPIC_BASE_URL is ${base || 'unset'}, so its traffic is NOT captured`);
}

async function run(args) {
  await start({ quiet: true });
  console.error(`http-inspect: capturing to ${CAPTURES}`);
  const child = spawn('claude', args, { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: PROXY_URL } });
  child.on('exit', (code, sig) => process.exit(sig ? 1 : code ?? 0));
}

async function hookSessionStart() {
  // Drain stdin so the hook runner does not block.
  process.stdin.resume();
  process.stdin.on('data', () => {});
  let msg;
  if (isSelf(process.env.ANTHROPIC_BASE_URL || '')) {
    try {
      const s = await start({ quiet: true });
      msg = `http-inspect: capturing model traffic via ${PROXY_URL} → ${s.upstream}. Use /http-inspect:list.`;
    } catch (e) {
      msg = `http-inspect: ANTHROPIC_BASE_URL points at ${PROXY_URL}, but the proxy failed to start: ${e.message}`;
    }
  } else if (process.env.HTTP_INSPECT_QUIET !== '1') {
    msg = `http-inspect: not capturing. Start Claude Code with ANTHROPIC_BASE_URL=${PROXY_URL}, or run \`node ${SELF} run\`.`;
  }
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
const full = rest.includes('--full');
const pos = rest.filter((a) => a !== '--full');
try {
  switch (cmd) {
    case 'serve': serve(); break;
    case 'start': await start(); break;
    case 'stop': await stop(); break;
    case 'status': await status(); break;
    case 'run': await run(rest[0] === '--' ? rest.slice(1) : rest); break;
    case 'list': list(Number(pos[0] || 20)); break;
    case 'show': show(pos[0], { full }); break;
    case 'path': console.log(path.join(CAPTURES, resolveId(pos[0]))); break;
    case 'hook-session-start': await hookSessionStart(); break;
    default:
      console.log(fs.readFileSync(SELF, 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`http-inspect: ${e.message}`);
  process.exit(1);
}
