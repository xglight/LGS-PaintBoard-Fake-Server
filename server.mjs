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

let paintCount = 0;
setInterval(() => {
    // logger.info(`🎨 Paint Rate: ${paintCount} pixels/sec`);
    const buf = Buffer.alloc(5);
    buf.writeUInt8(0xFE, 0); // 绘画速率消息类型
    buf.writeUInt32LE(paintCount, 1);
    for (const c of clients) {
        if (c.readyState === c.OPEN && !c._meta.writeonly) c.send(buf);
    }
    paintCount = 0;
}, 1000);

// WS 升级处理
wsServer.on('upgrade', (req, socket, head) => {
    try {
        const baseUrl = `${WS_CFG.protocol}://${req.headers.host}`;
        const url = new URL(req.url, baseUrl);

        const readonly = url.searchParams.has('readonly');
        const writeonly = url.searchParams.has('writeonly');
        const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';

        const counts = ipConnCounts.get(ip) || { rw: 0, ro: 0, wo: 0 };

        if (!readonly && !writeonly && counts.rw >= WS_CFG.maxReadWritePerIP) {
            logger.warn(`WS Upgrade denied: ${ip} (readonly=${readonly}, writeonly=${writeonly}) - Too Many ReadWrite Connections`);
            // return socket.end('HTTP/1.1 429 Too Many ReadWrite Connections\r\n\r\n');
        }
        if (readonly && counts.ro >= WS_CFG.maxReadOnlyPerIP) {
            logger.warn(`WS Upgrade denied: ${ip} (readonly=${readonly}, writeonly=${writeonly}) - Too Many ReadOnly Connections`);
            // return socket.end('HTTP/1.1 429 Too Many ReadOnly Connections\r\n\r\n');
        }
        if (writeonly && counts.wo >= WS_CFG.maxWriteOnlyPerIP) {
            logger.warn(`WS Upgrade denied: ${ip} (readonly=${readonly}, writeonly=${writeonly}) - Too Many WriteOnly Connections`);
            // return socket.end('HTTP/1.1 429 Too Many WriteOnly Connections\r\n\r\n');
        }

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
                lastPong: Date.now(),
                lastPing: Date.now()
            };
            wss.emit('connection', ws, req);
        });
        logger.debug(`WS Upgrade success: ${ip} (readonly=${readonly}, writeonly=${writeonly})`);
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
    logger.debug(`Connection closed: ${ip} (readonly=${meta.readonly}, writeonly=${meta.writeonly})`);
}

// 广播绘制事件
function broadcastDraw(x, y, r, g, b) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(0xfa, 0);
    buf.writeUInt16LE(x, 1);
    buf.writeUInt16LE(y, 3);
    buf.writeUInt8(r, 5);
    buf.writeUInt8(g, 6);
    buf.writeUInt8(b, 7);

    for (const c of clients) {
        if (c.readyState === c.OPEN && !c._meta.writeonly) {
            c.send(buf, { binary: true }, (err) => {
                if (err) logger.error('Send error:', err);
            });
        }
    }

    paintCount++;
    logger.info(`Broadcast draw: (${x},${y})  (${r},${g},${b})`);
}

// 发送绘制结果
function sendResult(ws, id, code) {
    const buf = Buffer.alloc(6);
    buf.writeUInt8(0xff, 0);
    buf.writeUInt32LE(id, 1);
    buf.writeUInt8(code, 5);
    ws.send(buf);
}

// 心跳机制
function startHeartbeat(ws) {
    const meta = ws._meta;
    const interval = WS_CFG.pingInterval ?? 30000;
    const timeout = WS_CFG.pingTimeout ?? 10000;
    meta.lastPing = meta.lastPong = Date.now();
    const timer = setInterval(() => {
        if (meta.lastPong - meta.lastPing > timeout) {
            logger.debug(`WS Ping timeout: ${meta.ip}`);
            ws.close(1001, 'Ping timeout');
        }
        logger.debug(`WS Ping: ${meta.ip}`);
        ws.send(Buffer.from([0xfc]));
        meta.lastPing = Date.now();
    }, interval);
    ws.on('close', () => clearInterval(timer));
}

// WebSocket 主逻辑
wss.on('connection', (ws) => {
    const meta = ws._meta;
    logger.info(`WS Connection: ${meta.ip} (readonly=${meta.readonly}, writeonly=${meta.writeonly})`);
    startHeartbeat(ws);
    clients.add(ws);

    ws.on('message', (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let offset = 0;

        while (offset < buf.length) {
            const type = buf.readUInt8(offset++);
            if (type === 0xfb) { meta.lastPong = Date.now(); continue; }
            if (type === 0xF0) {
                // 记录服务器接收时间（取低 32 位毫秒），以便客户端做延迟计算
                const serverTs = Date.now() & 0xFFFFFFFF;
                // 需要的数据长度（不含已读的 type 字节）为 14 字节
                const REQUIRED_LEN = 4 + 4 + 2 + 2 + 1 + 1 + 1; // ID(4) + ClientTs(4) + X(2) + Y(2) + R + G + B
                if (offset + REQUIRED_LEN > buf.length) {
                    ws.close(1002, 'Protocol violation: 0xF0 packet too short');
                    return;
                }

                try {
                    // 解析客户端发来的字段（全部按小端）
                    const id = buf.readUInt32LE(offset); offset += 4;
                    const clientTs = buf.readUInt32LE(offset); offset += 4;
                    const x = buf.readUInt16LE(offset); offset += 2;
                    const y = buf.readUInt16LE(offset); offset += 2;
                    const r = buf.readUInt8(offset++);
                    const g = buf.readUInt8(offset++);
                    const b = buf.readUInt8(offset++);

                    const outBuf = Buffer.alloc(20);
                    outBuf.writeUInt8(0xF0, 0);
                    outBuf.writeUInt32LE(id, 1);
                    outBuf.writeUInt32LE(clientTs, 5);
                    outBuf.writeUInt32LE(serverTs, 9);
                    outBuf.writeUInt16LE(x, 13);
                    outBuf.writeUInt16LE(y, 15);
                    outBuf.writeUInt8(r, 17);
                    outBuf.writeUInt8(g, 18);
                    outBuf.writeUInt8(b, 19);

                    for (const c of clients) {
                        if (c.readyState === c.OPEN && !c._meta.writeonly) {
                            c.send(outBuf, { binary: true }, (err) => {
                                if (err) logger.error('Send 0xF0 error:', err);
                            });
                        }
                    }

                    paintCount++;

                    logger.debug(`0xF0 received id=${id} clientTs=${clientTs} serverTs=${serverTs} coord=(${x},${y}) rgb=(${r},${g},${b})`);
                } catch (err) {
                    logger.error('Error handling 0xF0 packet:', err);
                    ws.close(1002, 'Protocol error while processing 0xF0');
                    return;
                }
                continue;
            }
            if (type !== 0xfe) { ws.close(1002, 'Protocol violation: unknown packet type'); return; }

            meta.packets = meta.packets.filter(t => Date.now() - t < 1000);
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
            offset += 16;

            const id = buf.readUInt32LE(offset); offset += 4;

            let dbToken = null;
            try {
                dbToken = getTokenStmt.get(uid)?.token;
            } catch (err) {
                logger.error(`DB token lookup failed: ${err}`);
                sendResult(ws, id, 0xed);
                continue;
            }


            const lastTime = meta.uidCooldown.get(uid) || 0;
            if (Date.now() - lastTime < TOKEN_CFG.cooldownMs) {
                sendResult(ws, id, 0xee);
                continue;
            }
            meta.uidCooldown.set(uid, Date.now());

            if (!setPixel(x, y, r, g, b)) {
                sendResult(ws, id, 0xec);
                continue;
            }

            broadcastDraw(x, y, r, g, b);
            sendResult(ws, id, 0xef);
        }
    });

    ws.on('close', () => {
        decIp(meta.ip, meta);
        clients.delete(ws);
    });
});

// 启动 WebSocket 服务器
wsServer.listen(WS_CFG.port, WS_CFG.host, () => {
    logger.info(`WebSocket 已启动：${WS_CFG.protocol}://${WS_CFG.host}:${WS_CFG.port}`);
});
