-- ============================================================
-- Migration 001 — Create core tables
-- Project: openclaw-teams
-- Engine:  PostgreSQL 15+
-- ============================================================
-- Run order: 1 of N
-- Dependencies: none
-- ============================================================

-- ============================================================
-- UP
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -------------------------------------------------------
-- ENUMS
-- -------------------------------------------------------

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

-- -------------------------------------------------------
-- Shared trigger function for updated_at
-- -------------------------------------------------------

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------
-- TABLE: agents
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS agents (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL,
    type        agent_type_enum NOT NULL,
    status      agent_status_enum NOT NULL DEFAULT 'idle',
    config      JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agents_name_unique UNIQUE (name),
    CONSTRAINT agents_config_is_object CHECK (jsonb_typeof(config) = 'object')
);

CREATE TRIGGER trg_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- -------------------------------------------------------
-- TABLE: agent_sessions
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_sessions (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID        NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    session_key VARCHAR(512) NOT NULL,
    state       JSONB       NOT NULL DEFAULT '{}',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,
    CONSTRAINT agent_sessions_session_key_unique UNIQUE (session_key),
    CONSTRAINT agent_sessions_ended_after_started CHECK (ended_at IS NULL OR ended_at > started_at),
    CONSTRAINT agent_sessions_state_is_object CHECK (jsonb_typeof(state) = 'object')
);

-- -------------------------------------------------------
-- TABLE: agent_tasks
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_tasks (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID        NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    task_type   VARCHAR(255) NOT NULL,
    input       JSONB       NOT NULL DEFAULT '{}',
    output      JSONB,
    status      task_status_enum NOT NULL DEFAULT 'pending',
    duration_ms INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_tasks_duration_positive CHECK (duration_ms IS NULL OR duration_ms >= 0),
    CONSTRAINT agent_tasks_input_is_object CHECK (jsonb_typeof(input) = 'object'),
    CONSTRAINT agent_tasks_output_is_object CHECK (output IS NULL OR jsonb_typeof(output) = 'object')
);

-- -------------------------------------------------------
-- TABLE: skills
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS skills (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    code        TEXT        NOT NULL,
    version     VARCHAR(32) NOT NULL DEFAULT '1.0.0',
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT skills_name_version_unique UNIQUE (name, version),
    CONSTRAINT skills_version_format CHECK (version ~ '^\d+\.\d+\.\d+$')
);

CREATE TRIGGER trg_skills_updated_at
    BEFORE UPDATE ON skills
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- -------------------------------------------------------
-- TABLE: workflows
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflows (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL,
    definition  JSONB       NOT NULL DEFAULT '{}',
    status      workflow_status_enum NOT NULL DEFAULT 'draft',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workflows_name_unique UNIQUE (name),
    CONSTRAINT workflows_definition_is_object CHECK (jsonb_typeof(definition) = 'object')
);

CREATE TRIGGER trg_workflows_updated_at
    BEFORE UPDATE ON workflows
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- -------------------------------------------------------
-- TABLE: workflow_runs
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_runs (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id   UUID        NOT NULL REFERENCES workflows (id) ON DELETE RESTRICT,
    state         JSONB       NOT NULL DEFAULT '{}',
    current_node  VARCHAR(255),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ,
    CONSTRAINT workflow_runs_completed_after_started CHECK (
        completed_at IS NULL OR completed_at >= started_at
    ),
    CONSTRAINT workflow_runs_state_is_object CHECK (jsonb_typeof(state) = 'object')
);

-- -------------------------------------------------------
-- TABLE: audit_log
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor       VARCHAR(255) NOT NULL,
    action      VARCHAR(255) NOT NULL,
    resource    VARCHAR(255) NOT NULL,
    data        JSONB,
    ip          INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutability enforcement
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

-- -------------------------------------------------------
-- TABLE: langgraph_states
-- Schema must match GraphMemoryManager.initialize() exactly.
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS langgraph_states (
    state_key   TEXT        PRIMARY KEY,
    state       JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_langgraph_states_updated_at
    BEFORE UPDATE ON langgraph_states
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- -------------------------------------------------------
-- TABLE: langgraph_edges
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS langgraph_edges (
    id          BIGSERIAL   PRIMARY KEY,
    state_key   TEXT        NOT NULL REFERENCES langgraph_states (state_key) ON DELETE CASCADE,
    from_node   TEXT,
    to_node     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- TABLE: langgraph_checkpoints
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
    id          BIGSERIAL   PRIMARY KEY,
    state_key   TEXT        NOT NULL REFERENCES langgraph_states (state_key) ON DELETE CASCADE,
    node_name   TEXT        NOT NULL,
    state       JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------
-- TABLE: langgraph_step_history
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS langgraph_step_history (
    id          BIGSERIAL   PRIMARY KEY,
    state_key   TEXT        NOT NULL REFERENCES langgraph_states (state_key) ON DELETE CASCADE,
    step_name   TEXT        NOT NULL,
    logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOWN
-- ============================================================

-- To roll back this migration, execute the DOWN section below.
-- WARNING: This is DESTRUCTIVE — all data will be lost.

/*
DOWN:

DROP TRIGGER IF EXISTS trg_langgraph_states_updated_at ON langgraph_states;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete      ON audit_log;
DROP TRIGGER IF EXISTS trg_audit_log_no_update      ON audit_log;
DROP TRIGGER IF EXISTS trg_workflows_updated_at     ON workflows;
DROP TRIGGER IF EXISTS trg_skills_updated_at        ON skills;
DROP TRIGGER IF EXISTS trg_agents_updated_at        ON agents;

DROP TABLE IF EXISTS langgraph_step_history CASCADE;
DROP TABLE IF EXISTS langgraph_checkpoints  CASCADE;
DROP TABLE IF EXISTS langgraph_edges        CASCADE;
DROP TABLE IF EXISTS langgraph_states       CASCADE;
DROP TABLE IF EXISTS audit_log          CASCADE;
DROP TABLE IF EXISTS workflow_runs      CASCADE;
DROP TABLE IF EXISTS workflows          CASCADE;
DROP TABLE IF EXISTS agent_tasks        CASCADE;
DROP TABLE IF EXISTS agent_sessions     CASCADE;
DROP TABLE IF EXISTS skills             CASCADE;
DROP TABLE IF EXISTS agents             CASCADE;

DROP FUNCTION IF EXISTS prevent_audit_log_mutation();
DROP FUNCTION IF EXISTS trigger_set_updated_at();

DROP TYPE IF EXISTS workflow_status_enum;
DROP TYPE IF EXISTS task_status_enum;
DROP TYPE IF EXISTS agent_status_enum;
DROP TYPE IF EXISTS agent_type_enum;
*/
