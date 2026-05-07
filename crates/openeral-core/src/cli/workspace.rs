use clap::{Args, Subcommand};
use std::path::PathBuf;
use tracing::info;

use crate::config::connection::resolve_connection_string;
use crate::config::types::WorkspaceMountConfig;
use crate::db::migrate;
use crate::db::pool::create_pool;
use crate::db::queries::workspace as ws_queries;
use crate::db::types::WorkspaceLayout;
use crate::error::FsError;
use crate::fs::workspace::WorkspaceFilesystem;

#[derive(Args)]
pub struct WorkspaceArgs {
    #[command(subcommand)]
    pub command: WorkspaceCommands,
}

#[derive(Subcommand)]
pub enum WorkspaceCommands {
    /// Create a new workspace
    Create(CreateArgs),
    /// Mount a workspace as a read-write filesystem
    Mount(MountWorkspaceArgs),
    /// Seed a workspace from a local directory
    Seed(SeedArgs),
    /// List all workspaces
    List,
    /// Delete a workspace and all its files
    Delete(DeleteArgs),
}

#[derive(Args)]
pub struct CreateArgs {
    /// PostgreSQL connection string
    #[arg(short, long)]
    pub connection: Option<String>,

    /// Workspace ID
    pub id: String,

    /// Display name
    #[arg(long)]
    pub display_name: Option<String>,

    /// Workspace config JSON (or @file.json)
    #[arg(long, default_value = "{}")]
    pub config: String,

    /// Skip database migrations
    #[arg(long)]
    pub skip_migrations: bool,
}

#[derive(Args)]
pub struct MountWorkspaceArgs {
    /// PostgreSQL connection string
    #[arg(short, long)]
    pub connection: Option<String>,

    /// Workspace ID
    pub id: String,

    /// Mount point path
    pub mount_point: PathBuf,

    /// Run in foreground
    #[arg(short, long)]
    pub foreground: bool,

    /// Statement timeout in seconds
    #[arg(long, default_value = "30")]
    pub statement_timeout: u64,

    /// Skip database migrations
    #[arg(long)]
    pub skip_migrations: bool,
}

#[derive(Args)]
pub struct SeedArgs {
    /// PostgreSQL connection string
    #[arg(short, long)]
    pub connection: Option<String>,

    /// Workspace ID
    pub id: String,

    /// Local directory to seed from
    #[arg(long)]
    pub from: PathBuf,

    /// Skip database migrations
    #[arg(long)]
    pub skip_migrations: bool,
}

#[derive(Args)]
pub struct DeleteArgs {
    /// PostgreSQL connection string
    #[arg(short, long)]
    pub connection: Option<String>,

    /// Workspace ID
    pub id: String,

    /// Skip database migrations
    #[arg(long)]
    pub skip_migrations: bool,
}

pub async fn execute(args: WorkspaceArgs) -> Result<(), FsError> {
    match args.command {
        WorkspaceCommands::Create(a) => execute_create(a).await,
        WorkspaceCommands::Mount(a) => execute_mount(a).await,
        WorkspaceCommands::Seed(a) => execute_seed(a).await,
        WorkspaceCommands::List => execute_list().await,
        WorkspaceCommands::Delete(a) => execute_delete(a).await,
    }
}

async fn execute_create(args: CreateArgs) -> Result<(), FsError> {
    let conn_str = resolve_connection_string(args.connection.as_deref(), "OPENERAL_DATABASE_URL")?;
    let pool = create_pool(&conn_str, 30)?;

    if !args.skip_migrations {
        migrate::run_migrations(&pool).await?;
    }

    // Parse config: support @file.json or inline JSON
    let config_str = if args.config.starts_with('@') {
        std::fs::read_to_string(&args.config[1..])
            .map_err(|e| FsError::InvalidArgument(format!("Failed to read config file: {}", e)))?
    } else {
        args.config
    };

    let layout: WorkspaceLayout = serde_json::from_str(&config_str)
        .map_err(|e| FsError::InvalidArgument(format!("Invalid config JSON: {}", e)))?;

    ws_queries::create_workspace(&pool, &args.id, args.display_name.as_deref(), &layout).await?;
    info!(workspace_id = %args.id, "Workspace created");

    // Seed from config
    ws_queries::seed_from_config(&pool, &args.id, &layout).await?;
    info!(workspace_id = %args.id, "Workspace seeded from config");

    println!("Workspace '{}' created successfully", args.id);
    Ok(())
}

async fn execute_mount(args: MountWorkspaceArgs) -> Result<(), FsError> {
    let conn_str = resolve_connection_string(args.connection.as_deref(), "OPENERAL_DATABASE_URL")?;
    let pool = create_pool(&conn_str, args.statement_timeout)?;

    // Test connection
    let client = pool
        .get()
        .await
        .map_err(|e| FsError::DatabaseError(format!("Connection failed: {}", e)))?;
    client
        .execute("SELECT 1", &[])
        .await
        .map_err(|e| FsError::DatabaseError(format!("Connection test failed: {}", e)))?;
    drop(client);

    if !args.skip_migrations {
        migrate::run_migrations(&pool).await?;
    }

    // Verify workspace exists
    let ws = ws_queries::get_workspace(&pool, &args.id).await?;
    info!(workspace_id = %ws.id, "Workspace found");

    // Ensure root and seeded dirs exist
    ws_queries::seed_from_config(&pool, &args.id, &ws.config).await?;

    let config = WorkspaceMountConfig {
        connection_string: conn_str,
        workspace_id: args.id.clone(),
        mount_point: args.mount_point.display().to_string(),
        display_name: ws.display_name,
        statement_timeout_secs: args.statement_timeout,
    };

    let mount_point = args.mount_point.clone();
    let fs = WorkspaceFilesystem::new(pool, &config, tokio::runtime::Handle::current());

    info!(mount_point = %mount_point.display(), workspace_id = %args.id, "Mounting workspace");

    let mut fuse_config = fuser::Config::default();
    fuse_config.mount_options = vec![
        fuser::MountOption::FSName("openeral-workspace".to_string()),
        fuser::MountOption::Subtype("openeral".to_string()),
    ];
    let handle = tokio::task::spawn_blocking(move || {
        fuser::mount2(fs, &mount_point, &fuse_config).map_err(FsError::IoError)
    });

    handle
        .await
        .map_err(|e| FsError::InternalError(format!("Mount task failed: {}", e)))??;
    Ok(())
}

async fn execute_seed(args: SeedArgs) -> Result<(), FsError> {
    let conn_str = resolve_connection_string(args.connection.as_deref(), "OPENERAL_DATABASE_URL")?;
    let pool = create_pool(&conn_str, 30)?;

    if !args.skip_migrations {
        migrate::run_migrations(&pool).await?;
    }

    // Verify workspace exists
    let ws = ws_queries::get_workspace(&pool, &args.id).await?;
    info!(workspace_id = %ws.id, "Seeding workspace from {:?}", args.from);

    // Ensure root exists
    ws_queries::seed_from_config(&pool, &args.id, &ws.config).await?;

    let count = ws_queries::seed_from_directory(&pool, &args.id, &args.from).await?;
    println!(
        "Seeded {} files/directories into workspace '{}'",
        count, args.id
    );
    Ok(())
}

async fn execute_list() -> Result<(), FsError> {
    let conn_str = resolve_connection_string(None, "OPENERAL_DATABASE_URL")?;
    let pool = create_pool(&conn_str, 30)?;

    let workspaces = ws_queries::list_workspaces(&pool).await?;

    if workspaces.is_empty() {
        println!("No workspaces found");
    } else {
        println!("{:<20} {:<30} {:<25}", "ID", "DISPLAY NAME", "CREATED");
        println!("{}", "-".repeat(75));
        for ws in workspaces {
            let display = ws.display_name.as_deref().unwrap_or("-");
            let created = ws
                .created_at
                .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| "-".to_string());
            println!("{:<20} {:<30} {:<25}", ws.id, display, created);
        }
    }
    Ok(())
}

async fn execute_delete(args: DeleteArgs) -> Result<(), FsError> {
    let conn_str = resolve_connection_string(args.connection.as_deref(), "OPENERAL_DATABASE_URL")?;
    let pool = create_pool(&conn_str, 30)?;

    if !args.skip_migrations {
        migrate::run_migrations(&pool).await?;
    }

    ws_queries::delete_workspace(&pool, &args.id).await?;
    println!("Workspace '{}' deleted", args.id);
    Ok(())
}
