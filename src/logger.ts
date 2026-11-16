/**
 * 脱敏日志：仅写入 stderr，stdout 严禁输出任何非协议内容（docs/architecture.md 第 6 节）。
 * 按配置级别过滤；silent 关闭全部日志。
 */
import type { LogLevel } from './config.js';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** 创建按级别过滤的 stderr 日志器。 */
export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_ORDER[level];
  const write = (tag: string, message: string): void => {
    if (threshold >= 100) return; // silent
    process.stderr.write(`[${tag}] ${message}\n`);
  };
  return {
    debug: (m) => threshold <= 10 && write('debug', m),
    info: (m) => threshold <= 20 && write('info', m),
    warn: (m) => threshold <= 30 && write('warn', m),
    error: (m) => threshold <= 40 && write('error', m),
  };
}
