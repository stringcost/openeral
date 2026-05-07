DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT USAGE ON SCHEMA _openeral TO service_role;
        GRANT SELECT ON ALL TABLES IN SCHEMA _openeral TO service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA _openeral GRANT SELECT ON TABLES TO service_role;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_user') THEN
        GRANT USAGE ON SCHEMA _openeral TO dashboard_user;
        GRANT SELECT ON ALL TABLES IN SCHEMA _openeral TO dashboard_user;
        ALTER DEFAULT PRIVILEGES IN SCHEMA _openeral GRANT SELECT ON TABLES TO dashboard_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT USAGE ON SCHEMA _openeral TO authenticated;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT USAGE ON SCHEMA _openeral TO anon;
    END IF;
END
$$;
