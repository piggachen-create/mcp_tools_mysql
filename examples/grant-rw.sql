-- MySQL MCP Tool 受控写账号授权脚本（仅 MYSQL_ALLOW_WRITE=true 时使用）
-- 来源：docs/tool-contracts-and-security.md 第 7.2 节
-- 用法：将 <强密码> 与 `app` 替换为实际值后，以管理员执行：
--   mysql -u root -p < examples/grant-rw.sql
-- 原则：在只读权限基础上仅追加 INSERT/UPDATE/DELETE；其余一律禁止。

CREATE USER 'mysql_mcp_rw'@'%' IDENTIFIED BY '<强密码>';

-- 只读基础（`app` 替换为目标业务库名）
GRANT SELECT, SHOW VIEW ON `app`.* TO 'mysql_mcp_rw'@'%';

-- 受控 DML：配合服务端写入白名单（INSERT / 带 WHERE 的 UPDATE|DELETE）使用
GRANT INSERT, UPDATE, DELETE ON `app`.* TO 'mysql_mcp_rw'@'%';

-- 严禁授予：FILE、PROCESS、RELOAD、SUPER、DDL、DCL 及 *.* 级授权

FLUSH PRIVILEGES;
