/**
 * @file 服务器主模块
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import config from './config.mjs';
import logger from './logger.mjs';

// =================== 初始化 SQLite 数据库 ===================
const db = new Database('./tokens.db');
db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  uid INTEGER PRIMARY KEY,
  token TEXT NOT NULL
);
`);

const getTokenStmt = db.prepare('SELECT token FROM tokens WHERE uid = ?');
const insertTokenStmt = db.prepare('INSERT OR REPLACE INTO tokens (uid, token) VALUES (?, ?)');

// =================== 初始化画板缓冲区 ===================
const { width: WIDTH, height: HEIGHT, channels: CHANNELS } = config.board;
const BOARD_SIZE = WIDTH * HEIGHT * CHANNELS;
const paintBoard = Buffer.alloc(BOARD_SIZE, 0xff); // 初始化为白色

// 设置单个像素（RGB）
function setPixel(x, y, r, g, b) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return false;
    const idx = (y * WIDTH + x) * CHANNELS;
    paintBoard[idx] = r;
    paintBoard[idx + 1] = g;
    paintBoard[idx + 2] = b;
    return true;
}

// =================== HTTP 服务 ===================
const app = Fastify({ logger: false });

await app.register(cors, {
    origin: '*'
});

// 获取画板
app.get('/api/paintboard/getboard', async (req, reply) => {
    logger.debug('GET /api/paintboard/getboard');
    reply.type('application/octet-stream');
    return reply.send(paintBoard);
});

// 检查 access_key 是否有效
function check_access_key(uid, access_key) {
    return true;
}

// 获取 token
app.post('/api/auth/gettoken', async (req, reply) => {
    const { uid, access_key } = req.body || {};
    if (typeof uid !== 'number' || uid < 0 || uid >= (1 << 24) || typeof access_key !== 'string' || !check_access_key(uid, access_key)) {
        return reply.status(400).send({ token: '', error: 'BAD_REQUEST' });
    }
    logger.debug(`POST /api/auth/gettoken, uid=${uid}`);
    let tokenRow = getTokenStmt.get(uid);
    if (!tokenRow) {
        const newToken = uuidv4();
        insertTokenStmt.run(uid, newToken);
        tokenRow = { token: newToken };
    }
    return reply.send({ token: tokenRow.token, errorType: '' });
});

// 启动 HTTP 服务器
app.listen({ host: config.api.host, port: config.api.port }, () => {
    logger.info(`🎨 HTTP API 已启动：${config.api.protocol}://${config.api.host}:${config.api.port}`);
});

// =================== WebSocket 服务 ===================
const wsServer = createServer();
const wss = new WebSocketServer({ noServer: true });
const ipConnCounts = new Map();
const clients = new Set();

const WS_CFG = config.websocket;
const TOKEN_CFG = config.token;

// WS 升级处理
wsServer.on('upgrade', (req, socket, head) => {
    try {
        const baseUrl = `${WS_CFG.protocol}://${req.headers.host}`;
        const url = new URL(req.url, baseUrl);

        const readonly = url.searchParams.has('readonly');
        const writeonly = url.searchParams.has('writeonly');
        const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';

        const counts = ipConnCounts.get(ip) || { rw: 0, ro: 0, wo: 0 };

        if (!readonly && !writeonly && counts.rw >= WS_CFG.maxReadWritePerIP)
            return socket.end('HTTP/1.1 429 Too Many ReadWrite Connections\r\n\r\n');
        if (readonly && counts.ro >= WS_CFG.maxReadOnlyPerIP)
            return socket.end('HTTP/1.1 429 Too Many ReadOnly Connections\r\n\r\n');
        if (writeonly && counts.wo >= WS_CFG.maxWriteOnlyPerIP)
            return socket.end('HTTP/1.1 429 Too Many WriteOnly Connections\r\n\r\n');

        if (!readonly && !writeonly) counts.rw++;
        if (readonly) counts.ro++;
        if (writeonly) counts.wo++;
        ipConnCounts.set(ip, counts);

        wss.handleUpgrade(req, socket, head, (ws) => {
            ws._meta = {
                ip,
                readonly,
                writeonly,
                packets: [],
                uidCooldown: new Map(),
                lastPong: Date.now()
            };
            wss.emit('connection', ws, req);
        });
        logger.debug('WS Upgrade success: %s (readonly=%s, writeonly=%s)', ip, readonly, writeonly);
    } catch (err) {
        logger.error('WS Upgrade error:', err);
        try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { }
    }
});

// 连接断开
function decIp(ip, meta) {
    const c = ipConnCounts.get(ip);
    if (!c) return;
    if (!meta.readonly && !meta.writeonly) c.rw--;
    if (meta.readonly) c.ro--;
    if (meta.writeonly) c.wo--;
    ipConnCounts.set(ip, c);
    logger.debug('Connection closed: %s (readonly=%s, writeonly=%s)', ip, meta.readonly, meta.writeonly);
}

// 广播绘制事件
function broadcastDraw(x, y, r, g, b) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(0xFA, 0);
    buf.writeUInt16LE(x, 1);
    buf.writeUInt16LE(y, 3);
    buf.writeUInt8(r, 5);
    buf.writeUInt8(g, 6);
    buf.writeUInt8(b, 7);
    for (const c of clients) {
        if (c.readyState === c.OPEN && !c._meta.writeonly) c.send(buf);
    }
    logger.info('Broadcast draw: %s, %s, %s, %s, %s', x, y, r, g, b);
}

// 发送绘制结果
function sendResult(ws, id, code) {
    const buf = Buffer.alloc(6);
    buf.writeUInt8(0xFF, 0);
    buf.writeUInt32LE(id, 1);
    buf.writeUInt8(code, 5);
    ws.send(buf);
}

// 心跳机制
function startHeartbeat(ws) {
    const meta = ws._meta;
    const interval = WS_CFG.pingInterval ?? 30000;
    const timeout = WS_CFG.pingTimeout ?? 10000;

    const timer = setInterval(() => {
        if (Date.now() - meta.lastPong > timeout) {
            ws.close(1001, 'Ping timeout');
        } else {
            ws.send(Buffer.from([0xFC]));
        }
    }, interval);
    ws.on('close', () => clearInterval(timer));
}

// WebSocket 主逻辑
wss.on('connection', (ws) => {
    const meta = ws._meta;
    clients.add(ws);
    startHeartbeat(ws);

    ws.on('message', (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let offset = 0;

        while (offset < buf.length) {
            const type = buf.readUInt8(offset++);
            if (type === 0xFB) { meta.lastPong = Date.now(); continue; }
            if (type !== 0xFE) { ws.close(1002, 'Protocol violation: unknown packet type'); return; }

            if (meta.packets.filter(t => Date.now() - t < 1000).length > WS_CFG.packetsPerSecond) {
                ws.close(1008, 'IP connection limit exceeded');
                return;
            }
            meta.packets.push(Date.now());

            if (offset + 29 > buf.length) { ws.close(1002, 'Protocol violation: unknown packet type'); return; }

            const x = buf.readUInt16LE(offset); offset += 2;
            const y = buf.readUInt16LE(offset); offset += 2;
            const r = buf.readUInt8(offset++);
            const g = buf.readUInt8(offset++);
            const b = buf.readUInt8(offset++);

            const uid = buf.readUInt8(offset) + (buf.readUInt8(offset + 1) << 8) + (buf.readUInt8(offset + 2) << 16);
            offset += 3;

            const tokenHex = buf.slice(offset, offset + 16).toString('hex');
            const tokenStr = `${tokenHex.slice(0, 8)}-${tokenHex.slice(8, 12)}-${tokenHex.slice(12, 16)}-${tokenHex.slice(16, 20)}-${tokenHex.slice(20)}`;
            offset += 16;

            const id = buf.readUInt32LE(offset); offset += 4;

            const dbToken = getTokenStmt.get(uid)?.token;
            if (TOKEN_CFG.check && (!dbToken || dbToken !== tokenStr)) {
                sendResult(ws, id, 0xED);
                continue;
            }

            const lastTime = meta.uidCooldown.get(uid) || 0;
            if (Date.now() - lastTime < TOKEN_CFG.cooldownMs) {
                sendResult(ws, id, 0xEE);
                continue;
            }
            meta.uidCooldown.set(uid, Date.now());

            if (!setPixel(x, y, r, g, b)) {
                sendResult(ws, id, 0xEC);
                continue;
            }

            broadcastDraw(x, y, r, g, b);
            sendResult(ws, id, 0xEF);
        }
    });

    ws.on('close', () => {
        decIp(meta.ip, meta);
        clients.delete(ws);
    });
});

// 启动 WebSocket 服务器
wsServer.listen(WS_CFG.port, WS_CFG.host, () => {
    logger.info(`🔌 WebSocket 已启动：${WS_CFG.protocol}://${WS_CFG.host}:${WS_CFG.port}`);
});
