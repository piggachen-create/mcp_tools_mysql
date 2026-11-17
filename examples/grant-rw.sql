-- MySQL MCP Tool: controlled-write account grant script (only for data sources with allowWrite=true)
-- Source: docs/tool-contracts-and-security.md section 7.2 (Chinese: docs/tool-contracts-and-security.zh-CN.md #7.2)
-- Usage: replace <strong password> and `app` with real values, then run as administrator:
--   mysql -u root -p < examples/grant-rw.sql
-- Principle: add only INSERT/UPDATE/DELETE on top of read-only privileges; forbid everything else.

CREATE USER 'mysql_mcp_rw'@'%' IDENTIFIED BY '<strong password>';

-- Read-only baseline (`app` = target business database name)
GRANT SELECT, SHOW VIEW ON `app`.* TO 'mysql_mcp_rw'@'%';

-- Controlled DML: matches the server-side write whitelist (INSERT / UPDATE|DELETE with WHERE)
GRANT INSERT, UPDATE, DELETE ON `app`.* TO 'mysql_mcp_rw'@'%';

-- Never grant: FILE, PROCESS, RELOAD, SUPER, DDL, DCL, or *.* scoped grants

FLUSH PRIVILEGES;
