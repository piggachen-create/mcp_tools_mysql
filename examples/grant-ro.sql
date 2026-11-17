-- MySQL MCP Tool: read-only account grant script (default mode)
-- Source: docs/tool-contracts-and-security.md section 7.1 (Chinese: docs/tool-contracts-and-security.zh-CN.md #7.1)
-- Usage: replace <strong password> and `app` with real values, then run as administrator:
--   mysql -u root -p < examples/grant-ro.sql
-- Principle: least privilege — grant only the target business database; forbid FILE/PROCESS/DDL/DCL.

CREATE USER 'mysql_mcp_ro'@'%' IDENTIFIED BY '<strong password>';

-- Data reads and view metadata (`app` = target business database name)
GRANT SELECT ON `app`.* TO 'mysql_mcp_ro'@'%';
GRANT SHOW VIEW ON `app`.* TO 'mysql_mcp_ro'@'%';

-- Metadata tools need information_schema reads (granted by default, no explicit GRANT needed)

FLUSH PRIVILEGES;
