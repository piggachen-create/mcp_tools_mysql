-- MySQL MCP Tool 只读账号授权脚本（默认模式）
-- 来源：docs/tool-contracts-and-security.md 第 7.1 节
-- 用法：将 <强密码> 与 `app` 替换为实际值后，以管理员执行：
--   mysql -u root -p < examples/grant-ro.sql
-- 原则：最小权限，仅授予目标业务库；禁止 FILE/PROCESS/DDL/DCL。

CREATE USER 'mysql_mcp_ro'@'%' IDENTIFIED BY '<强密码>';

-- 数据读取与视图元数据（`app` 替换为目标业务库名）
GRANT SELECT ON `app`.* TO 'mysql_mcp_ro'@'%';
GRANT SHOW VIEW ON `app`.* TO 'mysql_mcp_ro'@'%';

-- 元数据工具需要 information_schema 读取（默认已授予，无需显式 GRANT）

FLUSH PRIVILEGES;
