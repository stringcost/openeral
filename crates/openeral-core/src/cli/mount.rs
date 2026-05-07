use crate::config::connection::resolve_connection_string;
use crate::config::types::MountConfig;
use crate::db::migrate;
use crate::db::pool::create_pool;
use crate::error::FsError;
use crate::fs::PgmountFilesystem;
use clap::Args;
use std::path::PathBuf;
use tracing::info;

#[derive(Args)]
pub struct MountArgs {
    /// PostgreSQL connection string (postgres://user:pass@host/db)
    #[arg(short, long)]
    pub connection: Option<String>,

    /// Mount point path
    pub mount_point: PathBuf,

    /// Only show these schemas (comma-separated)
    #[arg(short, long, value_delimiter = ',')]
    pub schemas: Option<Vec<String>>,

    /// Cache TTL in seconds
    #[arg(long, default_value = "30")]
    pub cache_ttl: u64,

    /// Page size for row listing
    #[arg(long, default_value = "1000")]
    pub page_size: usize,

    /// Mount read-only (default: true)
    #[arg(long, default_value = "true")]
    pub read_only: bool,

    /// Statement timeout in seconds (per query)
    #[arg(long, default_value = "30")]
    pub statement_timeout: u64,

    /// Run in foreground (don't daemonize)
    #[arg(short, long)]
    pub foreground: bool,

    /// Skip database migrations on startup
    #[arg(long)]
    pub skip_migrations: bool,
}

pub async fn execute(args: MountArgs) -> Result<(), FsError> {
    let conn_str = resolve_connection_string(args.connection.as_deref(), "OPENERAL_DATABASE_URL")?;

    let config = MountConfig {
        connection_string: conn_str.clone(),
        mount_point: args.mount_point.display().to_string(),
        schemas: args.schemas,
        read_only: args.read_only,
        cache_ttl: std::time::Duration::from_secs(args.cache_ttl),
        page_size: args.page_size,
        statement_timeout_secs: args.statement_timeout,
    };

    info!(mount_point = %config.mount_point, "Creating connection pool");
    let pool = create_pool(&conn_str, config.statement_timeout_secs)?;

    // Test the connection
    let client = pool
        .get()
        .await
        .map_err(|e| FsError::DatabaseError(format!("Connection failed: {}", e)))?;
    client
        .execute("SELECT 1", &[])
        .await
        .map_err(|e| FsError::DatabaseError(format!("Connection test failed: {}", e)))?;
    drop(client);
    info!("Connection verified");

    // Run database migrations (creates _openeral schema and metadata tables)
    if !args.skip_migrations {
        migrate::run_migrations(&pool).await?;
        migrate::log_mount_session(
            &pool,
            &config.mount_point,
            config.schemas.as_deref(),
            config.page_size,
        )
        .await?;
    }

    let mount_point = args.mount_point.clone();

    // Create the filesystem
    let fs = PgmountFilesystem::new(pool, config, tokio::runtime::Handle::current());

    info!(mount_point = %mount_point.display(), "Mounting filesystem");

    // Mount config
    let mut fuse_config = fuser::Config::default();
    fuse_config.mount_options = vec![
        fuser::MountOption::RO,
        fuser::MountOption::FSName("openeral".to_string()),
        fuser::MountOption::Subtype("openeral".to_string()),
        fuser::MountOption::DefaultPermissions,
    ];
    // fuser::mount2 blocks, so run in a blocking thread
    let handle = tokio::task::spawn_blocking(move || {
        fuser::mount2(fs, &mount_point, &fuse_config).map_err(FsError::IoError)
    });

    handle
        .await
        .map_err(|e| FsError::InternalError(format!("Mount task failed: {}", e)))??;
    Ok(())
}
