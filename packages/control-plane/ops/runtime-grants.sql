-- 在独立迁移账号完成迁移后，由数据库管理员执行。
-- 本文件假设运行角色为 itervane_app；创建角色和设置密码不在此处执行。
GRANT CONNECT ON DATABASE itervane TO itervane_app;
GRANT USAGE ON SCHEMA itervane, itervane_queue, itervane_checkpoint TO itervane_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA itervane, itervane_queue, itervane_checkpoint TO itervane_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA itervane, itervane_queue, itervane_checkpoint TO itervane_app;
REVOKE CREATE ON SCHEMA itervane, itervane_queue, itervane_checkpoint FROM itervane_app;
REVOKE CREATE ON DATABASE itervane FROM itervane_app;
