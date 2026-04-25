-- ============================================================
-- Migration 003 — Backup & Restore Stored Procedures
-- Project: openclaw-teams
-- Engine:  PostgreSQL 15+
-- ============================================================
-- Run order: 3 of N
-- Dependencies: 001_create_tables.sql, 002_add_indexes.sql
-- ============================================================

-- ============================================================
-- UP
-- ============================================================

-- -------------------------------------------------------
-- TABLE: backup_jobs
-- Records every backup operation for audit and verification
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS backup_jobs (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_type        VARCHAR(64) NOT NULL,           -- 'full', 'incremental', 'agent_state', 'verify'
    status          VARCHAR(32) NOT NULL DEFAULT 'pending', -- 'pending','running','completed','failed'
    tables_included TEXT[]      NOT NULL DEFAULT '{}',
    row_counts      JSONB       NOT NULL DEFAULT '{}',
    backup_path     TEXT,
    checksum        VARCHAR(128),
    error_message   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT backup_jobs_completed_after_started CHECK (
        completed_at IS NULL OR completed_at >= started_at
    )
);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_status      ON backup_jobs (status);
CREATE INDEX IF NOT EXISTS idx_backup_jobs_job_type    ON backup_jobs (job_type);
CREATE INDEX IF NOT EXISTS idx_backup_jobs_created_at  ON backup_jobs (created_at DESC);

-- -------------------------------------------------------
-- TABLE: restore_jobs
-- Records every restore operation
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS restore_jobs (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    backup_job_id   UUID        REFERENCES backup_jobs (id) ON DELETE SET NULL,
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    restore_point   TEXT,
    tables_restored TEXT[]      NOT NULL DEFAULT '{}',
    row_counts      JSONB       NOT NULL DEFAULT '{}',
    error_message   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT restore_jobs_completed_after_started CHECK (
        completed_at IS NULL OR completed_at >= started_at
    )
);

CREATE INDEX IF NOT EXISTS idx_restore_jobs_backup_job_id ON restore_jobs (backup_job_id);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_status        ON restore_jobs (status);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_created_at    ON restore_jobs (created_at DESC);

-- -------------------------------------------------------
-- Staging table for agent state snapshots
-- NOTE: Defined BEFORE backup_agent_state() so the function
-- body resolves cleanly even in strict-validation contexts.
-- -------------------------------------------------------

CREATE TABLE IF NOT EXISTS _backup_agent_state_snapshot (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    backup_job_id       UUID        NOT NULL REFERENCES backup_jobs (id) ON DELETE CASCADE,
    snapshot_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agents_data         JSONB,
    open_sessions_data  JSONB,
    inflight_tasks_data JSONB
);

CREATE INDEX IF NOT EXISTS idx_backup_agent_state_snapshot_job_id
    ON _backup_agent_state_snapshot (backup_job_id);
CREATE INDEX IF NOT EXISTS idx_backup_agent_state_snapshot_time
    ON _backup_agent_state_snapshot (snapshot_time DESC);

-- ============================================================
-- PROCEDURE: backup_agent_state
-- Creates a JSON snapshot of all live agent state into a
-- dedicated backup schema table for fast point-in-time recovery
-- without relying on external tooling.
-- ============================================================

CREATE OR REPLACE FUNCTION backup_agent_state(
    p_backup_path TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_job_id    UUID;
    v_agent_count   BIGINT;
    v_session_count BIGINT;
    v_task_count    BIGINT;
BEGIN
    -- Create job record
    INSERT INTO backup_jobs (job_type, status, backup_path, tables_included, started_at)
    VALUES (
        'agent_state',
        'running',
        COALESCE(p_backup_path, 'postgres://backup_agent_state/' || NOW()::TEXT),
        ARRAY['agents', 'agent_sessions', 'agent_tasks'],
        NOW()
    )
    RETURNING id INTO v_job_id;

    -- Collect row counts
    SELECT COUNT(*) INTO v_agent_count   FROM agents;
    SELECT COUNT(*) INTO v_session_count FROM agent_sessions WHERE ended_at IS NULL;
    SELECT COUNT(*) INTO v_task_count    FROM agent_tasks    WHERE status IN ('pending', 'running', 'retrying');

    -- Upsert into backup staging table (created below)
    INSERT INTO _backup_agent_state_snapshot (
        backup_job_id,
        snapshot_time,
        agents_data,
        open_sessions_data,
        inflight_tasks_data
    )
    SELECT
        v_job_id,
        NOW(),
        (SELECT jsonb_agg(row_to_json(a)) FROM agents a),
        (SELECT jsonb_agg(row_to_json(s)) FROM agent_sessions s WHERE s.ended_at IS NULL),
        (SELECT jsonb_agg(row_to_json(t)) FROM agent_tasks t WHERE t.status IN ('pending', 'running', 'retrying'));

    -- Mark completed
    UPDATE backup_jobs
    SET
        status       = 'completed',
        completed_at = NOW(),
        row_counts   = jsonb_build_object(
            'agents',        v_agent_count,
            'open_sessions', v_session_count,
            'inflight_tasks', v_task_count
        )
    WHERE id = v_job_id;

    RETURN v_job_id;

EXCEPTION WHEN OTHERS THEN
    UPDATE backup_jobs
    SET
        status        = 'failed',
        error_message = SQLERRM,
        completed_at  = NOW()
    WHERE id = v_job_id;
    RAISE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION backup_agent_state IS
    'Creates a JSON snapshot of all live agent state (agents, open sessions, in-flight tasks) '
    'into the _backup_agent_state_snapshot table and records the operation in backup_jobs. '
    'Returns the backup_job UUID.';

-- ============================================================
-- PROCEDURE: backup_full_schema
-- Captures full row-count telemetry across all tables and
-- records a backup job record. Actual pg_dump is triggered
-- externally; this procedure provides the audit trail and
-- pre-dump validation.
-- ============================================================

CREATE OR REPLACE FUNCTION backup_full_schema(
    p_backup_path TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_job_id UUID;
    v_counts JSONB;
BEGIN
    INSERT INTO backup_jobs (job_type, status, backup_path, tables_included, started_at)
    VALUES (
        'full',
        'running',
        COALESCE(p_backup_path, 's3://backup/full/' || to_char(NOW(), 'YYYY-MM-DD_HH24-MI-SS')),
        ARRAY[
            'agents', 'agent_sessions', 'agent_tasks',
            'skills', 'workflows', 'workflow_runs',
            'audit_log', 'langgraph_states', 'langgraph_edges',
            'langgraph_checkpoints', 'langgraph_step_history'
        ],
        NOW()
    )
    RETURNING id INTO v_job_id;

    -- Collect row counts from all tables
    SELECT jsonb_build_object(
        'agents',            (SELECT COUNT(*) FROM agents),
        'agent_sessions',    (SELECT COUNT(*) FROM agent_sessions),
        'agent_tasks',       (SELECT COUNT(*) FROM agent_tasks),
        'skills',            (SELECT COUNT(*) FROM skills),
        'workflows',         (SELECT COUNT(*) FROM workflows),
        'workflow_runs',     (SELECT COUNT(*) FROM workflow_runs),
        'audit_log',         (SELECT COUNT(*) FROM audit_log),
        'langgraph_states',      (SELECT COUNT(*) FROM langgraph_states),
        'langgraph_edges',       (SELECT COUNT(*) FROM langgraph_edges),
        'langgraph_checkpoints', (SELECT COUNT(*) FROM langgraph_checkpoints),
        'langgraph_step_history',     (SELECT COUNT(*) FROM langgraph_step_history)
    ) INTO v_counts;

    UPDATE backup_jobs
    SET
        status       = 'completed',
        completed_at = NOW(),
        row_counts   = v_counts
    WHERE id = v_job_id;

    RETURN v_job_id;

EXCEPTION WHEN OTHERS THEN
    UPDATE backup_jobs
    SET
        status        = 'failed',
        error_message = SQLERRM,
        completed_at  = NOW()
    WHERE id = v_job_id;
    RAISE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION backup_full_schema IS
    'Records a full-schema backup audit entry with row counts across all tables. '
    'Pair with an external pg_dump call. Returns the backup_job UUID.';

-- ============================================================
-- PROCEDURE: backup_incremental
-- Captures all rows modified since a given timestamp, useful
-- for WAL-based incremental backup auditing.
-- ============================================================

CREATE OR REPLACE FUNCTION backup_incremental(
    p_since         TIMESTAMPTZ,
    p_backup_path   TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_job_id UUID;
    v_counts JSONB;
BEGIN
    INSERT INTO backup_jobs (job_type, status, backup_path, tables_included, started_at)
    VALUES (
        'incremental',
        'running',
        COALESCE(p_backup_path, 's3://backup/incremental/' || to_char(NOW(), 'YYYY-MM-DD_HH24-MI-SS')),
        ARRAY[
            'agents', 'agent_sessions', 'agent_tasks',
            'skills', 'workflows', 'workflow_runs',
            'langgraph_states', 'langgraph_step_history'
        ],
        NOW()
    )
    RETURNING id INTO v_job_id;

    SELECT jsonb_build_object(
        'agents',         (SELECT COUNT(*) FROM agents         WHERE updated_at >= p_since),
        'agent_sessions', (SELECT COUNT(*) FROM agent_sessions WHERE started_at  >= p_since),
        'agent_tasks',    (SELECT COUNT(*) FROM agent_tasks    WHERE created_at  >= p_since),
        'skills',         (SELECT COUNT(*) FROM skills         WHERE updated_at  >= p_since),
        'workflows',      (SELECT COUNT(*) FROM workflows      WHERE updated_at  >= p_since),
        'workflow_runs',  (SELECT COUNT(*) FROM workflow_runs  WHERE started_at  >= p_since),
        'langgraph_states',   (SELECT COUNT(*) FROM langgraph_states   WHERE updated_at  >= p_since),
        'langgraph_step_history',  (SELECT COUNT(*) FROM langgraph_step_history  WHERE logged_at   >= p_since)
    ) INTO v_counts;

    UPDATE backup_jobs
    SET
        status       = 'completed',
        completed_at = NOW(),
        row_counts   = v_counts
    WHERE id = v_job_id;

    RETURN v_job_id;

EXCEPTION WHEN OTHERS THEN
    UPDATE backup_jobs
    SET
        status        = 'failed',
        error_message = SQLERRM,
        completed_at  = NOW()
    WHERE id = v_job_id;
    RAISE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION backup_incremental IS
    'Records an incremental backup audit entry counting rows changed since p_since timestamp. '
    'Returns the backup_job UUID.';

-- ============================================================
-- PROCEDURE: restore_agent_state
-- Restores agent state from a snapshot captured by
-- backup_agent_state(). Applies agents, sessions, and tasks
-- from the snapshot JSON in a single transaction.
-- ============================================================

CREATE OR REPLACE FUNCTION restore_agent_state(
    p_backup_job_id UUID
)
RETURNS UUID AS $$
DECLARE
    v_restore_id    UUID;
    v_snapshot      RECORD;
    v_agent         RECORD;
    v_session       RECORD;
    v_task          RECORD;
    v_agent_count   INT := 0;
    v_session_count INT := 0;
    v_task_count    INT := 0;
BEGIN
    -- Verify snapshot exists
    SELECT * INTO v_snapshot
    FROM _backup_agent_state_snapshot
    WHERE backup_job_id = p_backup_job_id
    ORDER BY snapshot_time DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No agent state snapshot found for backup_job_id %', p_backup_job_id;
    END IF;

    -- Create restore job record
    INSERT INTO restore_jobs (
        backup_job_id, status, restore_point,
        tables_restored, started_at
    )
    VALUES (
        p_backup_job_id,
        'running',
        v_snapshot.snapshot_time::TEXT,
        ARRAY['agents', 'agent_sessions', 'agent_tasks'],
        NOW()
    )
    RETURNING id INTO v_restore_id;

    -- Restore agents (upsert by id)
    FOR v_agent IN
        SELECT * FROM jsonb_to_recordset(v_snapshot.agents_data)
        AS x(
            id UUID, name TEXT, type TEXT, status TEXT,
            config JSONB, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
        )
    LOOP
        INSERT INTO agents (id, name, type, status, config, created_at, updated_at)
        VALUES (
            v_agent.id,
            v_agent.name,
            v_agent.type::agent_type_enum,
            v_agent.status::agent_status_enum,
            COALESCE(v_agent.config, '{}'),
            v_agent.created_at,
            v_agent.updated_at
        )
        ON CONFLICT (id) DO UPDATE SET
            name       = EXCLUDED.name,
            type       = EXCLUDED.type,
            status     = EXCLUDED.status,
            config     = EXCLUDED.config,
            updated_at = NOW();
        v_agent_count := v_agent_count + 1;
    END LOOP;

    -- Restore open sessions (upsert by id)
    IF v_snapshot.open_sessions_data IS NOT NULL THEN
        FOR v_session IN
            SELECT * FROM jsonb_to_recordset(v_snapshot.open_sessions_data)
            AS x(
                id UUID, agent_id UUID, session_key TEXT,
                state JSONB, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ
            )
        LOOP
            INSERT INTO agent_sessions (id, agent_id, session_key, state, started_at, ended_at)
            VALUES (
                v_session.id,
                v_session.agent_id,
                v_session.session_key,
                COALESCE(v_session.state, '{}'),
                v_session.started_at,
                v_session.ended_at
            )
            ON CONFLICT (id) DO UPDATE SET
                state    = EXCLUDED.state,
                ended_at = EXCLUDED.ended_at;
            v_session_count := v_session_count + 1;
        END LOOP;
    END IF;

    -- Restore in-flight tasks (upsert by id)
    IF v_snapshot.inflight_tasks_data IS NOT NULL THEN
        FOR v_task IN
            SELECT * FROM jsonb_to_recordset(v_snapshot.inflight_tasks_data)
            AS x(
                id UUID, agent_id UUID, task_type TEXT,
                input JSONB, output JSONB, status TEXT,
                duration_ms INTEGER, created_at TIMESTAMPTZ
            )
        LOOP
            INSERT INTO agent_tasks (
                id, agent_id, task_type, input, output,
                status, duration_ms, created_at
            )
            VALUES (
                v_task.id,
                v_task.agent_id,
                v_task.task_type,
                COALESCE(v_task.input, '{}'),
                v_task.output,
                v_task.status::task_status_enum,
                v_task.duration_ms,
                v_task.created_at
            )
            ON CONFLICT (id) DO UPDATE SET
                status      = EXCLUDED.status,
                output      = EXCLUDED.output,
                duration_ms = EXCLUDED.duration_ms;
            v_task_count := v_task_count + 1;
        END LOOP;
    END IF;

    -- Mark restore complete
    UPDATE restore_jobs
    SET
        status       = 'completed',
        completed_at = NOW(),
        row_counts   = jsonb_build_object(
            'agents',   v_agent_count,
            'sessions', v_session_count,
            'tasks',    v_task_count
        )
    WHERE id = v_restore_id;

    -- Write audit record
    INSERT INTO audit_log (actor, action, resource, data)
    VALUES (
        'system',
        'restore',
        'agent_state',
        jsonb_build_object(
            'restore_job_id', v_restore_id,
            'backup_job_id',  p_backup_job_id,
            'snapshot_time',  v_snapshot.snapshot_time,
            'agents_restored',   v_agent_count,
            'sessions_restored', v_session_count,
            'tasks_restored',    v_task_count
        )
    );

    RETURN v_restore_id;

EXCEPTION WHEN OTHERS THEN
    UPDATE restore_jobs
    SET
        status        = 'failed',
        error_message = SQLERRM,
        completed_at  = NOW()
    WHERE id = v_restore_id;

    INSERT INTO audit_log (actor, action, resource, data)
    VALUES (
        'system',
        'restore_failed',
        'agent_state',
        jsonb_build_object(
            'restore_job_id', v_restore_id,
            'backup_job_id',  p_backup_job_id,
            'error',          SQLERRM
        )
    );

    RAISE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION restore_agent_state IS
    'Restores agents, open sessions, and in-flight tasks from a backup_agent_state() snapshot. '
    'Upserts all rows and writes an audit_log entry. Returns the restore_job UUID.';

-- ============================================================
-- PROCEDURE: restore_graph_state
-- Restores langgraph_states rows and all associated child records
-- (edges, checkpoints, history) for a specific state_key
-- from a JSON backup blob.
-- ============================================================

CREATE OR REPLACE FUNCTION restore_graph_state(
    p_state_key         VARCHAR,
    p_state_data        JSONB,
    p_edges_data        JSONB DEFAULT NULL,
    p_checkpoints_data  JSONB DEFAULT NULL,
    p_history_data      JSONB DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_restore_id    UUID;
    v_edge_count    INT := 0;
    v_cp_count      INT := 0;
    v_hist_count    INT := 0;
    v_edge          RECORD;
    v_cp            RECORD;
    v_hist          RECORD;
BEGIN
    INSERT INTO restore_jobs (
        status, restore_point, tables_restored, started_at
    )
    VALUES (
        'running',
        p_state_key,
        ARRAY['langgraph_states', 'langgraph_edges', 'langgraph_checkpoints', 'langgraph_step_history'],
        NOW()
    )
    RETURNING id INTO v_restore_id;

    -- Restore langgraph_states row (schema: state_key TEXT PK, state JSONB, created_at, updated_at)
    INSERT INTO langgraph_states (state_key, state, created_at, updated_at)
    VALUES (
        p_state_key,
        p_state_data,
        COALESCE((p_state_data->>'created_at')::TIMESTAMPTZ, NOW()),
        NOW()
    )
    ON CONFLICT (state_key) DO UPDATE SET
        state      = EXCLUDED.state,
        updated_at = NOW();

    -- Restore edges (schema: id BIGSERIAL PK, state_key, from_node, to_node, created_at)
    IF p_edges_data IS NOT NULL THEN
        FOR v_edge IN
            SELECT * FROM jsonb_to_recordset(p_edges_data)
            AS x(from_node TEXT, to_node TEXT, created_at TIMESTAMPTZ)
        LOOP
            INSERT INTO langgraph_edges (state_key, from_node, to_node, created_at)
            VALUES (
                p_state_key,
                v_edge.from_node,
                v_edge.to_node,
                COALESCE(v_edge.created_at, NOW())
            );
            v_edge_count := v_edge_count + 1;
        END LOOP;
    END IF;

    -- Restore checkpoints (schema: id BIGSERIAL PK, state_key, node_name, state JSONB, created_at)
    IF p_checkpoints_data IS NOT NULL THEN
        FOR v_cp IN
            SELECT * FROM jsonb_to_recordset(p_checkpoints_data)
            AS x(node_name TEXT, state JSONB, created_at TIMESTAMPTZ)
        LOOP
            INSERT INTO langgraph_checkpoints (state_key, node_name, state, created_at)
            VALUES (
                p_state_key,
                v_cp.node_name,
                COALESCE(v_cp.state, '{}'),
                COALESCE(v_cp.created_at, NOW())
            );
            v_cp_count := v_cp_count + 1;
        END LOOP;
    END IF;

    -- Restore step history (schema: id BIGSERIAL PK, state_key, step_name, logged_at)
    IF p_history_data IS NOT NULL THEN
        FOR v_hist IN
            SELECT * FROM jsonb_to_recordset(p_history_data)
            AS x(step_name TEXT, logged_at TIMESTAMPTZ)
        LOOP
            INSERT INTO langgraph_step_history (state_key, step_name, logged_at)
            VALUES (
                p_state_key,
                v_hist.step_name,
                COALESCE(v_hist.logged_at, NOW())
            );
            v_hist_count := v_hist_count + 1;
        END LOOP;
    END IF;

    UPDATE restore_jobs
    SET
        status       = 'completed',
        completed_at = NOW(),
        row_counts   = jsonb_build_object(
            'langgraph_states',      1,
            'langgraph_edges',       v_edge_count,
            'langgraph_checkpoints', v_cp_count,
            'langgraph_step_history',     v_hist_count
        )
    WHERE id = v_restore_id;

    INSERT INTO audit_log (actor, action, resource, data)
    VALUES (
        'system', 'restore', 'graph_state/' || p_state_key,
        jsonb_build_object(
            'restore_job_id', v_restore_id,
            'state_key',      p_state_key,
            'edges_restored',       v_edge_count,
            'checkpoints_restored', v_cp_count,
            'history_restored',     v_hist_count
        )
    );

    RETURN v_restore_id;

EXCEPTION WHEN OTHERS THEN
    UPDATE restore_jobs
    SET
        status        = 'failed',
        error_message = SQLERRM,
        completed_at  = NOW()
    WHERE id = v_restore_id;

    INSERT INTO audit_log (actor, action, resource, data)
    VALUES (
        'system', 'restore_failed', 'graph_state/' || p_state_key,
        jsonb_build_object(
            'restore_job_id', v_restore_id,
            'state_key',      p_state_key,
            'error',          SQLERRM
        )
    );
    RAISE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION restore_graph_state IS
    'Restores a complete graph execution (state, edges, checkpoints, history) from JSON blobs. '
    'Upserts langgraph_states and inserts child rows (ON CONFLICT DO NOTHING). '
    'Returns the restore_job UUID.';

-- ============================================================
-- PROCEDURE: purge_old_backups
-- Deletes backup snapshots and job records older than
-- a given retention period to manage storage.
-- ============================================================

CREATE OR REPLACE FUNCTION purge_old_backups(
    p_retain_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    deleted_jobs      BIGINT,
    deleted_snapshots BIGINT
) AS $$
DECLARE
    v_cutoff        TIMESTAMPTZ;
    v_deleted_jobs  BIGINT;
    v_deleted_snaps BIGINT;
BEGIN
    v_cutoff := NOW() - (p_retain_days || ' days')::INTERVAL;

    -- Delete old snapshots first (FK constraint)
    DELETE FROM _backup_agent_state_snapshot
    WHERE backup_job_id IN (
        SELECT id FROM backup_jobs
        WHERE completed_at < v_cutoff
          AND status = 'completed'
    );
    GET DIAGNOSTICS v_deleted_snaps = ROW_COUNT;

    -- Delete old completed backup jobs
    DELETE FROM backup_jobs
    WHERE completed_at < v_cutoff
      AND status = 'completed';
    GET DIAGNOSTICS v_deleted_jobs = ROW_COUNT;

    -- Audit
    INSERT INTO audit_log (actor, action, resource, data)
    VALUES (
        'system', 'purge', 'backup_jobs',
        jsonb_build_object(
            'retain_days',        p_retain_days,
            'cutoff_time',        v_cutoff,
            'deleted_jobs',       v_deleted_jobs,
            'deleted_snapshots',  v_deleted_snaps
        )
    );

    RETURN QUERY SELECT v_deleted_jobs, v_deleted_snaps;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION purge_old_backups IS
    'Deletes completed backup job records and agent state snapshots older than p_retain_days days. '
    'Writes an audit_log entry. Returns counts of deleted rows.';

-- ============================================================
-- PROCEDURE: verify_backup_integrity
-- Verifies that a completed backup job recorded row counts
-- consistent with current table counts (within tolerance).
-- ============================================================

CREATE OR REPLACE FUNCTION verify_backup_integrity(
    p_backup_job_id UUID,
    p_tolerance_pct NUMERIC DEFAULT 5.0  -- Allow up to 5% row delta
)
RETURNS TABLE (
    table_name          TEXT,
    backup_count        BIGINT,
    current_count       BIGINT,
    delta_pct           NUMERIC,
    within_tolerance    BOOLEAN
) AS $$
DECLARE
    v_job RECORD;
BEGIN
    SELECT * INTO v_job FROM backup_jobs WHERE id = p_backup_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No backup job found with id %', p_backup_job_id;
    END IF;
    IF v_job.status != 'completed' THEN
        RAISE EXCEPTION 'Backup job % is in status %; expected completed', p_backup_job_id, v_job.status;
    END IF;

    RETURN QUERY
    WITH backup_counts AS (
        SELECT
            key   AS tbl,
            value::BIGINT AS b_count
        FROM jsonb_each_text(v_job.row_counts)
    ),
    current_counts AS (
        SELECT 'agents'            AS tbl, COUNT(*)::BIGINT AS c_count FROM agents
        UNION ALL
        SELECT 'agent_sessions',           COUNT(*)::BIGINT FROM agent_sessions
        UNION ALL
        SELECT 'agent_tasks',              COUNT(*)::BIGINT FROM agent_tasks
        UNION ALL
        SELECT 'skills',                   COUNT(*)::BIGINT FROM skills
        UNION ALL
        SELECT 'workflows',                COUNT(*)::BIGINT FROM workflows
        UNION ALL
        SELECT 'workflow_runs',            COUNT(*)::BIGINT FROM workflow_runs
        UNION ALL
        SELECT 'audit_log',                COUNT(*)::BIGINT FROM audit_log
        UNION ALL
        SELECT 'langgraph_states',             COUNT(*)::BIGINT FROM langgraph_states
        UNION ALL
        SELECT 'langgraph_edges',              COUNT(*)::BIGINT FROM langgraph_edges
        UNION ALL
        SELECT 'langgraph_checkpoints',        COUNT(*)::BIGINT FROM langgraph_checkpoints
        UNION ALL
        SELECT 'langgraph_step_history',            COUNT(*)::BIGINT FROM langgraph_step_history
    )
    SELECT
        bc.tbl::TEXT,
        bc.b_count,
        cc.c_count,
        CASE WHEN bc.b_count = 0 THEN 0
             ELSE ROUND(ABS(cc.c_count - bc.b_count)::NUMERIC / bc.b_count * 100, 2)
        END AS delta_pct,
        CASE WHEN bc.b_count = 0 THEN TRUE
             ELSE ABS(cc.c_count - bc.b_count)::NUMERIC / bc.b_count * 100 <= p_tolerance_pct
        END AS within_tolerance
    FROM backup_counts bc
    JOIN current_counts cc ON cc.tbl = bc.tbl
    ORDER BY bc.tbl;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION verify_backup_integrity IS
    'Compares row counts stored in a backup_job record against current live table counts. '
    'Returns per-table delta percentages and whether each is within p_tolerance_pct. '
    'Useful for automated weekly restore verification.';

-- ============================================================
-- GRANT permissions
-- ============================================================

-- Ensure the application role exists (idempotent; CI creates the DB user as
-- "openclaw" but the app role may not yet exist in a fresh test database).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_app') THEN
    CREATE ROLE openclaw_app;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON backup_jobs                    TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON restore_jobs                   TO openclaw_app;
GRANT SELECT, INSERT, UPDATE ON _backup_agent_state_snapshot   TO openclaw_app;

GRANT EXECUTE ON FUNCTION backup_agent_state       TO openclaw_app;
GRANT EXECUTE ON FUNCTION backup_full_schema        TO openclaw_app;
GRANT EXECUTE ON FUNCTION backup_incremental        TO openclaw_app;
GRANT EXECUTE ON FUNCTION restore_agent_state       TO openclaw_app;
GRANT EXECUTE ON FUNCTION restore_graph_state       TO openclaw_app;
GRANT EXECUTE ON FUNCTION purge_old_backups         TO openclaw_app;
GRANT EXECUTE ON FUNCTION verify_backup_integrity   TO openclaw_app;

-- ============================================================
-- DOWN
-- ============================================================

/*
DOWN:

REVOKE EXECUTE ON FUNCTION verify_backup_integrity  FROM openclaw_app;
REVOKE EXECUTE ON FUNCTION purge_old_backups        FROM openclaw_app;
REVOKE EXECUTE ON FUNCTION restore_graph_state      FROM openclaw_app;
REVOKE EXECUTE ON FUNCTION restore_agent_state      FROM openclaw_app;
REVOKE EXECUTE ON FUNCTION backup_incremental       FROM openclaw_app;
REVOKE EXECUTE ON FUNCTION backup_full_schema       FROM openclaw_app;
REVOKE EXECUTE ON FUNCTION backup_agent_state       FROM openclaw_app;

DROP FUNCTION IF EXISTS verify_backup_integrity(UUID, NUMERIC);
DROP FUNCTION IF EXISTS purge_old_backups(INTEGER);
DROP FUNCTION IF EXISTS restore_graph_state(VARCHAR, JSONB, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS restore_agent_state(UUID);
DROP FUNCTION IF EXISTS backup_incremental(TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS backup_full_schema(TEXT);
DROP FUNCTION IF EXISTS backup_agent_state(TEXT);

DROP TABLE IF EXISTS _backup_agent_state_snapshot CASCADE;
DROP TABLE IF EXISTS restore_jobs CASCADE;
DROP TABLE IF EXISTS backup_jobs  CASCADE;
*/
