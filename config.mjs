/**
 * @file 集中管理服务器配置的模块
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let configData = {};
try {
    configData = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
} catch (err) {
    console.warn('读取 config.json 失败，将使用默认配置喵:', err.message);
}

/**
 * api 配置
 * @type {object}
 */
const API_CONFIG = {
    protocol: configData.api?.protocol || 'http',
    host: configData.api?.host || 'localhost',
    port: configData.api?.port || 3000,
};

/**
 * 日志等级
 * @type {string}
 */
const LOG_LEVEL = configData.log?.logLevel || 'info';

/**
 * 画板配置
 * @type {object}
 */
const BOARD_CONFIG = {
    height: configData.board?.height || 600,
    width: configData.board?.width || 1000,
    channels: configData.board?.channels || 3,
};

/**
 * 令牌配置
 * @type {object}
 */
const TOKEN_CONFIG = {
    cooldownMs: configData.token?.cooldownMs ?? 1, // 默认 1 ms
    check: configData.token?.check ?? false,
};

/**
 * websocket 配置
 * @type {object}
 */
const WEBSOCKET_CONFIG = {
    protocol: configData.websocket?.protocol || 'ws',
    host: configData.websocket?.host || 'localhost',
    port: configData.websocket?.port || 3001,
    maxReadWritePerIP: configData.websocket?.maxReadWritePerIP ?? 3,
    maxReadOnlyPerIP: configData.websocket?.maxReadOnlyPerIP ?? 50,
    maxWriteOnlyPerIP: configData.websocket?.maxWriteOnlyPerIP ?? 5,
    packetsPerSecond: configData.websocket?.packetsPerSecond ?? 256,
    pingInterval: configData.websocket?.pingInterval ?? 30000,
    pingTimeout: configData.websocket?.pingTimeout ?? 10000,
};

export default {
    api: API_CONFIG,
    logLevel: LOG_LEVEL,
    board: BOARD_CONFIG,
    token: TOKEN_CONFIG,
    websocket: WEBSOCKET_CONFIG,
};
