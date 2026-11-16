/**
 * 服务入口：解析多数据源配置（fail-fast）→ 组装 ConnectionManager → 创建 Server → 绑定 stdio。
 * 进程退出清理：SIGINT/SIGTERM/未捕获异常时优雅关闭 Server 与全部连接池（见 docs/architecture.md 第 4 节）。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadSourcesConfig } from './config.js';
import { ConfigError } from './errors.js';
import { createLogger } from './logger.js';
import { ConnectionManager } from './pool.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  // 1. 解析多数据源配置（读 JSON 文件 + 展开环境变量引用），任一项非法直接 fail-fast 退出
  const sources = loadSourcesConfig();
  const logger = createLogger(sources.global.logLevel);
  logger.info(
    `配置解析通过：default=${sources.global.defaultTarget} sources=${sources.sources.map((s) => s.target).join(',')} logLevel=${sources.global.logLevel}`,
  );

  // 2. 多源连接管理器（懒建每源池）与 Server
  const manager = new ConnectionManager(
    sources.sources,
    { poolSize: sources.global.poolSize, poolIdleTimeoutMs: sources.global.poolIdleTimeoutMs },
    sources.global.defaultTarget,
  );
  const server = createServer({
    sources,
    resolveRunner: (target) => manager.resolve(target),
    resolveWriter: (target) => manager.resolveWriter(target),
    configFor: (target) => manager.configFor(target),
    logger,
  });
  logger.info(
    `mysql-mcp-tool 已启动（stdio 模式，${sources.sources.length} 个数据源，默认 ${sources.global.defaultTarget}）`,
  );

  // 3. 绑定 stdio transport：stdout 仅输出 MCP 协议帧
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 4. 进程退出清理：关闭 Server 与全部连接池后退出
  let closing = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info(`收到 ${signal}，开始优雅关闭`);
    try {
      await server.close();
      await manager.endAll();
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
