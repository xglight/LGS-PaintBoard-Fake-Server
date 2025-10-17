/**
 * @file 日志模块
 */
import config from './config.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Generate a timestamped log file name
const getLogFileName = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `server-${year}-${month}-${day}-${hours}-${minutes}-${seconds}.log`;
};

const logFile = path.join(logDir, getLogFileName());
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const levels = {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5
};

const currentLevel = levels[config.logLevel] !== undefined ? levels[config.logLevel] : 3;

const colors = {
    trace: '\x1b[90m', // grey
    debug: '\x1b[34m', // blue
    info: '\x1b[32m',  // green
    warn: '\x1b[33m',  // yellow
    error: '\x1b[31m', // red
    fatal: '\x1b[35m', // magenta
    reset: '\x1b[0m'
};

const stripAnsi = (str) => str.replace(/[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

function log(level, ...args) {
    if (levels[level] > currentLevel) {
        return;
    }
    const timestamp = new Date().toISOString();
    const color = colors[level] || colors.info;

    // Log to console with colors
    console.log(`${color}[${timestamp}] [${level.toUpperCase()}]${colors.reset}`, ...args);

    // Prepare message for file logging (without colors)
    const fileMessage = `[${timestamp}] [${level.toUpperCase()}] ${args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            try {
                return JSON.stringify(arg);
            } catch (e) {
                return 'Unserializable Object';
            }
        }
        return String(arg);
    }).join(' ')}\n`;

    // Write to log file
    logStream.write(stripAnsi(fileMessage));
}

export default {
    trace: (...args) => log('trace', ...args),
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
    fatal: (...args) => log('fatal', ...args),
};