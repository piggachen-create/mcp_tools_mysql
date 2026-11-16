/**
 * 服务入口：解析配置（fail-fast）→ 创建 Server → 绑定 stdio transport。
 * M1 范围：协议骨架与配置；SQL 能力在 M2/M3 提供。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { createServer } from './server.js';

/** stderr 脱敏日志：绝不输出密码等敏感值。 */
function log(level: string, message: string): void {
  process.stderr.write(`[${level}] ${message}\n`);
}

async function main(): Promise<void> {
  // 1. 配置解析与校验，任一项非法直接 fail-fast 退出
  const config = loadConfig();
  log(
    'info',
    `配置解析通过：host=${config.host} port=${config.port} tls=${config.tls} allowWrite=${config.allowWrite}`,
  );

  // 2. 创建 Server 并注册工具（写入工具条件注册）
  const server = createServer(config);
  log(
    'info',
    `mysql-mcp-tool 已启动（stdio 模式，工具集${config.allowWrite ? '含受控写入' : '仅只读'}）`,
  );

  // 3. 绑定 stdio transport：stdout 仅输出 MCP 协议帧
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 4. 进程退出清理
  const shutdown = async (signal: string): Promise<void> => {
    log('info', `收到 ${signal}，开始优雅关闭`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // 启动失败：仅输出配置项名，不含值（脱敏）
    log('error', `启动失败（CONFIG_INVALID）：${error.message}`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  log('error', `启动失败（INTERNAL）：${message}`);
  process.exit(1);
});
