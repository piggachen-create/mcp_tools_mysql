/**
 * MCP Server 创建与工具注册。
 * stdout 仅承载 MCP 协议帧；所有日志走 stderr（见 docs/architecture.md）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolConfig } from './tools.js';

export const SERVER_NAME = 'mysql-mcp-tool';
export const SERVER_VERSION = '0.1.0';

/** 创建 McpServer 并按启动配置注册工具（mysql_execute 条件注册）。 */
export function createServer(toolConfig: ToolConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, toolConfig);
  return server;
}
