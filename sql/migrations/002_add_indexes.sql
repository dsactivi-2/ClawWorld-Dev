-- ============================================================
-- Migration 002 — Add performance indexes
-- Project: openclaw-teams
-- Engine:  PostgreSQL 15+
-- ============================================================
-- Run order: 2 of N
-- Dependencies: 001_create_tables.sql
-- ============================================================

-- ============================================================
-- UP
-- ============================================================

-- -------------------------------------------------------
-- agents indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_type
    ON agents (type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_status
    ON agents (status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_created_at
    ON agents (created_at DESC);

-- GIN index for flexible JSONB queries on agent config
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_config_gin
    ON agents USING GIN (config);

-- Partial index: only active/idle agents (most frequent filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_active
    ON agents (type, status)
    WHERE status IN ('active', 'idle');

-- -------------------------------------------------------
-- agent_sessions indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_sessions_agent_id
    ON agent_sessions (agent_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_sessions_started_at
    ON agent_sessions (started_at DESC);

-- Partial index: only open sessions (ended_at IS NULL)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_sessions_active
    ON agent_sessions (agent_id)
    WHERE ended_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_sessions_ended_at
    ON agent_sessions (ended_at DESC)
    WHERE ended_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_sessions_state_gin
    ON agent_sessions USING GIN (state);

-- -------------------------------------------------------
-- agent_tasks indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_agent_id
    ON agent_tasks (agent_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_status
    ON agent_tasks (status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_task_type
    ON agent_tasks (task_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_created_at
    ON agent_tasks (created_at DESC);

-- Composite: most common filter — tasks for a given agent in a given status
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_agent_status
    ON agent_tasks (agent_id, status);

-- Partial index: only non-terminal tasks (in flight)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_inflight
    ON agent_tasks (agent_id, created_at DESC)
    WHERE status IN ('pending', 'running', 'retrying');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_input_gin
    ON agent_tasks USING GIN (input);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_tasks_output_gin
    ON agent_tasks USING GIN (output)
    WHERE output IS NOT NULL;

-- -------------------------------------------------------
-- skills indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_name
    ON skills (name);

-- Partial index: only active skills
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_active
    ON skills (name, version)
    WHERE active = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_created_at
    ON skills (created_at DESC);

-- Full-text search on skill name and description
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_fts
    ON skills USING GIN (
        to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))
    );

-- -------------------------------------------------------
-- workflows indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflows_status
    ON workflows (status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflows_created_at
    ON workflows (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflows_def_gin
    ON workflows USING GIN (definition);

-- Partial index: only runnable workflows
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflows_runnable
    ON workflows (name)
    WHERE status IN ('active');

-- -------------------------------------------------------
-- workflow_runs indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_workflow_id
    ON workflow_runs (workflow_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_started_at
    ON workflow_runs (started_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_completed_at
    ON workflow_runs (completed_at DESC)
    WHERE completed_at IS NOT NULL;

-- Partial index: in-flight runs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_active
    ON workflow_runs (workflow_id, started_at DESC)
    WHERE completed_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_state_gin
    ON workflow_runs USING GIN (state);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_current_node
    ON workflow_runs (current_node)
    WHERE current_node IS NOT NULL;

-- -------------------------------------------------------
-- audit_log indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_actor
    ON audit_log (actor);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_action
    ON audit_log (action);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_resource
    ON audit_log (resource);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_created_at
    ON audit_log (created_at DESC);

-- Composite: actor+time for user activity reports
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_actor_created
    ON audit_log (actor, created_at DESC);

-- Composite: resource+time for resource history lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_resource_created
    ON audit_log (resource, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_data_gin
    ON audit_log USING GIN (data)
    WHERE data IS NOT NULL;

-- -------------------------------------------------------
-- langgraph_states indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_states_state_key
    ON langgraph_states (state_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_states_deployment_ready
    ON langgraph_states (deployment_ready)
    WHERE deployment_ready = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_states_created_at
    ON langgraph_states (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_states_updated_at
    ON langgraph_states (updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_states_state_data_gin
    ON langgraph_states USING GIN (state_data);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_states_team_results_gin
    ON langgraph_states USING GIN (team_results);

-- -------------------------------------------------------
-- langgraph_edges indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_edges_state_key
    ON langgraph_edges (state_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_edges_from_node
    ON langgraph_edges (from_node);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_edges_to_node
    ON langgraph_edges (to_node);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_edges_timestamp
    ON langgraph_edges (timestamp DESC);

-- Composite: all edges for a state ordered by time (replay)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_edges_state_time
    ON langgraph_edges (state_key, timestamp ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_edges_decision_gin
    ON langgraph_edges USING GIN (decision_data)
    WHERE decision_data IS NOT NULL;

-- -------------------------------------------------------
-- langgraph_checkpoints indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_checkpoints_state_key
    ON langgraph_checkpoints (state_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_checkpoints_checkpoint_id
    ON langgraph_checkpoints (checkpoint_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_checkpoints_node_name
    ON langgraph_checkpoints (node_name);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_checkpoints_created_at
    ON langgraph_checkpoints (created_at DESC);

-- Composite: latest checkpoint per state (resume lookup)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_checkpoints_state_created
    ON langgraph_checkpoints (state_key, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_checkpoints_state_data_gin
    ON langgraph_checkpoints USING GIN (state_data);

-- -------------------------------------------------------
-- langgraph_history indexes
-- -------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_state_key
    ON langgraph_history (state_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_node_name
    ON langgraph_history (node_name);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_success
    ON langgraph_history (success);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_timestamp
    ON langgraph_history (timestamp DESC);

-- Composite: per-state per-node history
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_state_node
    ON langgraph_history (state_key, node_name);

-- Partial index: failed executions only (error investigation)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_failed
    ON langgraph_history (state_key, timestamp DESC)
    WHERE success = FALSE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_input_gin
    ON langgraph_history USING GIN (input_data);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_langgraph_history_output_gin
    ON langgraph_history USING GIN (output_data)
    WHERE output_data IS NOT NULL;

-- ============================================================
-- DOWN
-- ============================================================

/*
DOWN:

-- langgraph_history
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_output_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_input_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_failed;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_state_node;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_timestamp;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_success;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_node_name;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_history_state_key;

-- langgraph_checkpoints
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_checkpoints_state_data_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_checkpoints_state_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_checkpoints_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_checkpoints_node_name;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_checkpoints_checkpoint_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_checkpoints_state_key;

-- langgraph_edges
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_edges_decision_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_edges_state_time;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_edges_timestamp;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_edges_to_node;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_edges_from_node;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_edges_state_key;

-- langgraph_states
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_states_team_results_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_states_state_data_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_states_updated_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_states_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_states_deployment_ready;
DROP INDEX CONCURRENTLY IF EXISTS idx_langgraph_states_state_key;

-- audit_log
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_data_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_resource_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_actor_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_resource;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_action;
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_actor;

-- workflow_runs
DROP INDEX CONCURRENTLY IF EXISTS idx_workflow_runs_current_node;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflow_runs_state_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflow_runs_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflow_runs_completed_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflow_runs_started_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflow_runs_workflow_id;

-- workflows
DROP INDEX CONCURRENTLY IF EXISTS idx_workflows_runnable;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflows_def_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflows_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_workflows_status;

-- skills
DROP INDEX CONCURRENTLY IF EXISTS idx_skills_fts;
DROP INDEX CONCURRENTLY IF EXISTS idx_skills_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_skills_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_skills_name;

-- agent_tasks
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_output_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_input_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_inflight;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_agent_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_task_type;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_tasks_agent_id;

-- agent_sessions
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_sessions_state_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_sessions_ended_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_sessions_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_sessions_started_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_agent_sessions_agent_id;

-- agents
DROP INDEX CONCURRENTLY IF EXISTS idx_agents_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_agents_config_gin;
DROP INDEX CONCURRENTLY IF EXISTS idx_agents_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_agents_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_agents_type;
*/
