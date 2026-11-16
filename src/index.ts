/**
 * 服务入口：解析配置（fail-fast）→ 创建连接池/日志/Server → 绑定 stdio transport。
 * 进程退出清理：SIGINT/SIGTERM/未捕获异常时优雅关闭 Server 与连接池（见 docs/architecture.md 第 4 节）。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { createLogger } from './logger.js';
import { MysqlPool } from './pool.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  // 1. 配置解析与校验，任一项非法直接 fail-fast 退出
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info(
    `配置解析通过：host=${config.host} port=${config.port} tls=${config.tls} allowWrite=${config.allowWrite}`,
  );

  // 2. 连接池（懒连接）与 Server
  const pool = new MysqlPool(config);
  const server = createServer({ config, runner: pool, logger });
  logger.info(
    `mysql-mcp-tool 已启动（stdio 模式，工具集${config.allowWrite ? '含受控写入' : '仅只读'}）`,
  );

  // 3. 绑定 stdio transport：stdout 仅输出 MCP 协议帧
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 4. 进程退出清理：关闭 Server 与连接池后退出
  let closing = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info(`收到 ${signal}，开始优雅关闭`);
    try {
      await server.close();
      await pool.end();
    } finally {
      process.exit(exitCode);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('uncaughtException', (error) => {
    logger.error(`未捕获异常：${error.message}`);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝：${String(reason)}`);
    void shutdown('unhandledRejection', 1);
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // 启动失败：仅输出配置项名与错误消息，不含配置值（脱敏）
    process.stderr.write(`[error] 启动失败（CONFIG_INVALID）：${error.message}\n`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[error] 启动失败（INTERNAL）：${message}\n`);
  process.exit(1);
});
