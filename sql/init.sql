-- ============================================================
-- openclaw-teams — Database Initialization
-- Engine: PostgreSQL 15+
-- ============================================================

-- Ensure we are in the correct schema
SET search_path TO public;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- ============================================================
-- ENUMS
-- ============================================================

DO $$ BEGIN
    CREATE TYPE agent_type_enum AS ENUM ('builder', 'supervisor', 'worker');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE agent_status_enum AS ENUM ('active', 'idle', 'paused', 'stopped', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE task_status_enum AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled', 'retrying');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE workflow_status_enum AS ENUM ('draft', 'active', 'running', 'completed', 'failed', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- TRIGGER FUNCTION: auto-update updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TABLE: agents
-- Core registry of all agent definitions and current state
-- ============================================================

CREATE TABLE IF NOT EXISTS agents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL,
    type        agent_type_enum NOT NULL,
    status      agent_status_enum NOT NULL DEFAULT 'idle',
    config      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT agents_name_unique UNIQUE (name),
    CONSTRAINT agents_config_is_object CHECK (jsonb_typeof(config) = 'object')
);

COMMENT ON TABLE agents IS 'Registry of all agent definitions, types, and operational status';
COMMENT ON COLUMN agents.config IS 'Agent-specific configuration blob: model, tools, memory settings, cost limits, etc.';

CREATE INDEX IF NOT EXISTS idx_agents_type       ON agents (type);
CREATE INDEX IF NOT EXISTS idx_agents_status     ON agents (status);
CREATE INDEX IF NOT EXISTS idx_agents_created_at ON agents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_config_gin ON agents USING GIN (config);

CREATE TRIGGER trg_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- TABLE: agent_sessions
-- Per-agent session tracking with full state persistence
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_sessions (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    session_key VARCHAR(512) NOT NULL,
    state       JSONB NOT NULL DEFAULT '{}',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,

    CONSTRAINT agent_sessions_session_key_unique UNIQUE (session_key),
    CONSTRAINT agent_sessions_ended_after_started CHECK (ended_at IS NULL OR ended_at > started_at),
    CONSTRAINT agent_sessions_state_is_object CHECK (jsonb_typeof(state) = 'object')
);

COMMENT ON TABLE agent_sessions IS 'Session lifecycle records for each agent invocation, including serialized state';
COMMENT ON COLUMN agent_sessions.session_key IS 'Unique opaque key used to resume or reference a session from external callers';
COMMENT ON COLUMN agent_sessions.state IS 'Full serialized agent state: conversation history, tool context, memory pointers';

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_id   ON agent_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at ON agent_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_ended_at   ON agent_sessions (ended_at DESC) WHERE ended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_sessions_active     ON agent_sessions (agent_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_sessions_state_gin  ON agent_sessions USING GIN (state);

-- ============================================================
-- TABLE: agent_tasks
-- Individual task executions dispatched to agents
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_tasks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    task_type   VARCHAR(255) NOT NULL,
    input       JSONB NOT NULL DEFAULT '{}',
    output      JSONB,
    status      task_status_enum NOT NULL DEFAULT 'pending',
    duration_ms INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT agent_tasks_duration_positive CHECK (duration_ms IS NULL OR duration_ms >= 0),
    CONSTRAINT agent_tasks_input_is_object CHECK (jsonb_typeof(input) = 'object'),
    CONSTRAINT agent_tasks_output_is_object CHECK (output IS NULL OR jsonb_typeof(output) = 'object')
);

COMMENT ON TABLE agent_tasks IS 'Individual task invocations: inputs, outputs, status, and execution duration';
COMMENT ON COLUMN agent_tasks.task_type IS 'Logical task category, e.g. code_generation, code_review, test_generation';
COMMENT ON COLUMN agent_tasks.duration_ms IS 'Wall-clock execution time in milliseconds; NULL while task is pending/running';

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id   ON agent_tasks (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status     ON agent_tasks (status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_task_type  ON agent_tasks (task_type);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_status ON agent_tasks (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_input_gin  ON agent_tasks USING GIN (input);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_output_gin ON agent_tasks USING GIN (output) WHERE output IS NOT NULL;

-- ============================================================
-- TABLE: skills
-- Reusable skill definitions that agents can invoke
-- ============================================================

CREATE TABLE IF NOT EXISTS skills (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    code        TEXT NOT NULL,
    version     VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT skills_name_version_unique UNIQUE (name, version),
    CONSTRAINT skills_version_format CHECK (version ~ '^\d+\.\d+\.\d+$')
);

COMMENT ON TABLE skills IS 'Library of callable skills: versioned code snippets agents can dynamically load and execute';
COMMENT ON COLUMN skills.code IS 'Full source code of the skill implementation (TypeScript/JavaScript)';
COMMENT ON COLUMN skills.version IS 'Semantic version string (MAJOR.MINOR.PATCH)';

CREATE INDEX IF NOT EXISTS idx_skills_name       ON skills (name);
CREATE INDEX IF NOT EXISTS idx_skills_active     ON skills (active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_skills_created_at ON skills (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_name_active ON skills (name, active);

CREATE TRIGGER trg_skills_updated_at
    BEFORE UPDATE ON skills
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- TABLE: workflows
-- DAG workflow definitions
-- ============================================================

CREATE TABLE IF NOT EXISTS workflows (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL,
    definition  JSONB NOT NULL DEFAULT '{}',
    status      workflow_status_enum NOT NULL DEFAULT 'draft',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT workflows_name_unique UNIQUE (name),
    CONSTRAINT workflows_definition_is_object CHECK (jsonb_typeof(definition) = 'object')
);

COMMENT ON TABLE workflows IS 'Workflow DAG definitions: node graphs, edge lists, entry points, and configuration';
COMMENT ON COLUMN workflows.definition IS 'Full workflow graph: nodes[], edges[], entryNode, exitNodes, parallelism settings';

CREATE INDEX IF NOT EXISTS idx_workflows_status     ON workflows (status);
CREATE INDEX IF NOT EXISTS idx_workflows_created_at ON workflows (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_def_gin    ON workflows USING GIN (definition);

CREATE TRIGGER trg_workflows_updated_at
    BEFORE UPDATE ON workflows
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- TABLE: workflow_runs
-- Individual executions of a workflow definition
-- ============================================================

CREATE TABLE IF NOT EXISTS workflow_runs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id   UUID NOT NULL REFERENCES workflows (id) ON DELETE RESTRICT,
    state         JSONB NOT NULL DEFAULT '{}',
    current_node  VARCHAR(255),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,

    CONSTRAINT workflow_runs_completed_after_started CHECK (
        completed_at IS NULL OR completed_at >= started_at
    ),
    CONSTRAINT workflow_runs_state_is_object CHECK (jsonb_typeof(state) = 'object')
);

COMMENT ON TABLE workflow_runs IS 'Runtime execution instances of workflow definitions, including live state and progress';
COMMENT ON COLUMN workflow_runs.current_node IS 'Name of the currently executing node; NULL when run is complete or not yet started';

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id  ON workflow_runs (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started_at   ON workflow_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_completed_at ON workflow_runs (completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_active       ON workflow_runs (workflow_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_state_gin    ON workflow_runs USING GIN (state);

-- ============================================================
-- TABLE: audit_log
-- Immutable append-only audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor       VARCHAR(255) NOT NULL,
    action      VARCHAR(255) NOT NULL,
    resource    VARCHAR(255) NOT NULL,
    data        JSONB,
    ip          INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- NOTE: No updated_at — audit records are immutable
);

COMMENT ON TABLE audit_log IS 'Immutable audit trail. Do NOT add an updated_at trigger — rows must never be modified after insert.';
COMMENT ON COLUMN audit_log.actor IS 'Identity of the entity performing the action: user ID, agent ID, or system service name';
COMMENT ON COLUMN audit_log.action IS 'Verb describing the action: create, read, update, delete, execute, login, logout, etc.';
COMMENT ON COLUMN audit_log.resource IS 'Fully qualified resource identifier, e.g. agents/uuid, workflows/uuid';
COMMENT ON COLUMN audit_log.data IS 'Contextual payload: before/after state for mutations, request parameters for reads';
COMMENT ON COLUMN audit_log.ip IS 'Source IP address of the request originator';

CREATE INDEX IF NOT EXISTS idx_audit_log_actor      ON audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource   ON audit_log (resource);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created ON audit_log (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_data_gin   ON audit_log USING GIN (data) WHERE data IS NOT NULL;

-- ============================================================
-- ROW-LEVEL SECURITY: prevent audit_log updates/deletes
-- ============================================================

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_insert_only
    ON audit_log
    FOR ALL
    USING (TRUE)
    WITH CHECK (TRUE);

-- Prevent updates
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log rows are immutable — UPDATE and DELETE are not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER trg_audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- ============================================================
-- VIEW: active_agents
-- ============================================================

CREATE OR REPLACE VIEW active_agents AS
SELECT
    a.id,
    a.name,
    a.type,
    a.status,
    a.config,
    a.created_at,
    COUNT(DISTINCT s.id) FILTER (WHERE s.ended_at IS NULL)  AS open_sessions,
    COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'running') AS running_tasks
FROM agents a
LEFT JOIN agent_sessions s ON s.agent_id = a.id
LEFT JOIN agent_tasks    t ON t.agent_id = a.id
WHERE a.status NOT IN ('stopped')
GROUP BY a.id;

COMMENT ON VIEW active_agents IS 'Live view of non-stopped agents with open session and running task counts';

-- ============================================================
-- VIEW: task_summary
-- ============================================================

CREATE OR REPLACE VIEW task_summary AS
SELECT
    a.name                          AS agent_name,
    a.type                          AS agent_type,
    t.task_type,
    t.status,
    COUNT(*)                        AS task_count,
    AVG(t.duration_ms)              AS avg_duration_ms,
    MIN(t.duration_ms)              AS min_duration_ms,
    MAX(t.duration_ms)              AS max_duration_ms,
    MIN(t.created_at)               AS first_task_at,
    MAX(t.created_at)               AS last_task_at
FROM agent_tasks t
JOIN agents a ON a.id = t.agent_id
GROUP BY a.name, a.type, t.task_type, t.status;

COMMENT ON VIEW task_summary IS 'Aggregated task statistics grouped by agent, task type, and status';

-- ============================================================
-- GRANT baseline permissions (application role)
-- ============================================================

DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openclaw_app') THEN
        CREATE ROLE openclaw_app;
    END IF;
END $$;

DO $$
BEGIN
    EXECUTE 'GRANT CONNECT ON DATABASE ' || quote_ident(current_database()) || ' TO openclaw_app';
END $$;
GRANT USAGE ON SCHEMA public TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON agents          TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON agent_sessions  TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON agent_tasks     TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON skills          TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON workflows       TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON workflow_runs   TO openclaw_app;
GRANT SELECT, INSERT          ON audit_log      TO openclaw_app;
GRANT SELECT ON active_agents  TO openclaw_app;
GRANT SELECT ON task_summary   TO openclaw_app;
