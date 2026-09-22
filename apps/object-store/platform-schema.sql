CREATE TABLE IF NOT EXISTS platform_users (address TEXT PRIMARY KEY, vault TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_challenges (id TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS platform_sessions (hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_goals (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_goals_owner ON platform_goals(owner,updated_at);
CREATE TABLE IF NOT EXISTS platform_commands (id TEXT PRIMARY KEY, owner TEXT NOT NULL, type TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', result TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_commands_pending ON platform_commands(status,created_at);
CREATE TABLE IF NOT EXISTS platform_intents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_rate (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_health (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, block_number INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS platform_events_task ON platform_events(task_id,block_number);
CREATE TABLE IF NOT EXISTS platform_executors (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, owner TEXT, approved INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_executors_owner ON platform_executors(owner);
CREATE TABLE IF NOT EXISTS platform_agent_grants (id TEXT PRIMARY KEY, signer TEXT NOT NULL, body TEXT);
CREATE TABLE IF NOT EXISTS platform_runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, executor_id TEXT, task_id TEXT NOT NULL, attempt TEXT NOT NULL, body TEXT NOT NULL, result_hash TEXT, result_body TEXT, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(task_id,attempt,owner));
CREATE INDEX IF NOT EXISTS platform_runs_executor ON platform_runs(executor_id,created_at);
CREATE TABLE IF NOT EXISTS platform_hosted_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL, body TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, cancelled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_hosted_jobs_owner ON platform_hosted_jobs(owner,created_at);
CREATE TABLE IF NOT EXISTS platform_hosted_usage (day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS platform_model_budgets (key TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS platform_model_calls (id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, attempt TEXT NOT NULL, run_id TEXT, provider TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS platform_model_calls_task ON platform_model_calls(task_id,attempt);
CREATE INDEX IF NOT EXISTS platform_model_calls_owner ON platform_model_calls(owner,created_at);
CREATE TABLE IF NOT EXISTS platform_webhook_receipts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS platform_activity_reads (owner TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner,id));
CREATE INDEX IF NOT EXISTS platform_runs_owner ON platform_runs(owner,created_at);
CREATE INDEX IF NOT EXISTS platform_goals_task ON platform_goals(json_extract(body,'$.taskId'));

-- Public accounting only; signed raw payment transactions remain in the payment actor.
CREATE TABLE IF NOT EXISTS platform_tool_payments (id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, attempt TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), payer TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, tx_hash TEXT, gas_wei TEXT, evidence_hash TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_tool_payments_task ON platform_tool_payments(task_id,attempt);
CREATE INDEX IF NOT EXISTS platform_tool_payments_day ON platform_tool_payments(day);

CREATE TABLE IF NOT EXISTS tool_service_orders (id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, credential_hash TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS platform_private_reviews (result_hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt TEXT NOT NULL, envelope TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS platform_private_reviews_task ON platform_private_reviews(task_id,attempt);
