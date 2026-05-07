//! Handle invocation by mount.fuse3.
//!
//! When the system calls `mount -t fuse.openeral <source> <mountpoint>`,
//! mount.fuse3 invokes openeral in one of two ways:
//!
//! Without drop_privileges:
//!   openeral <source> <mountpoint> -o <options>
//!   (openeral opens /dev/fuse and mounts itself)
//!
//! With drop_privileges:
//!   openeral <source> /dev/fd/N -o <options>
//!   (mount.fuse3 pre-opens /dev/fuse, openeral uses the fd)

use std::os::fd::{FromRawFd, OwnedFd};
use std::path::PathBuf;

use tracing::info;

use crate::config::connection::resolve_connection_string;
use crate::config::types::{MountConfig, WorkspaceMountConfig};
use crate::db::migrate;
use crate::db::pool::create_pool;
use crate::db::queries::workspace as ws_queries;
use crate::error::FsError;
use crate::fs::workspace::WorkspaceFilesystem;
use crate::fs::PgmountFilesystem;

const KNOWN_SUBCOMMANDS: &[&str] = &[
    "bootstrap",
    "memory",
    "mount",
    "migrate",
    "optimize",
    "unmount",
    "list",
    "version",
    "workspace",
    "help",
];

/// Detect mount.fuse3 invocation pattern.
///
/// mount.fuse3 calls: `openeral <source> <mountpoint> -o <opts>`
/// where <source> is a connection string, never matching a known subcommand.
pub fn is_fuse_fd_invocation() -> bool {
    is_fuse_fd_source_arg(std::env::args().nth(1).as_deref())
}

fn is_fuse_fd_source_arg(arg: Option<&str>) -> bool {
    arg.map(|arg| !KNOWN_SUBCOMMANDS.contains(&arg) && !arg.starts_with('-'))
        .unwrap_or(false)
}

/// Extract the fd number from a /dev/fd/N path.
fn parse_dev_fd(path: &str) -> Option<i32> {
    path.strip_prefix("/dev/fd/")
        .and_then(|n| n.parse::<i32>().ok())
        .filter(|&fd| fd >= 0)
}

/// Parse the source string into connection string and optional workspace id.
///
/// Format:
///   - Database: `<connstr>`
///   - Database (env): `env` (reads OPENERAL_DATABASE_URL from environment)
///   - Workspace: `<connstr>#workspace#<id>`
///   - Workspace (env): `env#workspace#<id>`
fn parse_source(source: &str) -> (String, Option<String>) {
    if let Some(idx) = source.find("#workspace#") {
        let conn_part = &source[..idx];
        let workspace_id = source[idx + "#workspace#".len()..].to_string();
        let conn_str = resolve_source_conn(conn_part);
        (conn_str, Some(workspace_id))
    } else {
        (resolve_source_conn(source), None)
    }
}

/// Resolve the connection portion of a source string.
/// If "env", returns empty string so resolve_connection_string falls through to env var.
fn resolve_source_conn(source: &str) -> String {
    if source == "env" {
        String::new()
    } else {
        source.to_string()
    }
}

/// Parse -o option string into flags.
struct MountOptions {
    read_only: bool,
}

fn parse_mount_options(args: &[String]) -> MountOptions {
    let mut read_only = false;

    // Find -o argument and parse comma-separated options
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-o" {
            if let Some(opts) = iter.next() {
                for opt in opts.split(',') {
                    match opt.trim() {
                        "ro" => read_only = true,
                        "rw" => read_only = false,
                        _ => {} // ignore options handled by mount.fuse3 (allow_other, etc.)
                    }
                }
            }
        }
    }

    MountOptions { read_only }
}

/// Create an OwnedFd from a raw fd number, verifying it is valid.
fn claim_fuse_fd(fd_num: i32) -> Result<OwnedFd, FsError> {
    // Verify the fd is open
    let ret = unsafe { libc::fcntl(fd_num, libc::F_GETFD) };
    if ret == -1 {
        return Err(FsError::InvalidArgument(format!(
            "/dev/fd/{} is not a valid open file descriptor",
            fd_num
        )));
    }

    Ok(unsafe { OwnedFd::from_raw_fd(fd_num) })
}

/// How the FUSE mount will be established.
enum MountMode {
    /// mount.fuse3 pre-opened the fd — use Session::from_fd()
    PreOpenedFd(OwnedFd),
    /// Regular mountpoint path — use mount2() (same as direct `openeral mount`)
    MountPoint(PathBuf),
}

/// Entry point for mount.fuse3 invocation.
///
/// Without drop_privileges: openeral <source> <mountpoint> [-o options]
/// With drop_privileges:    openeral <source> /dev/fd/N [-o options]
pub async fn execute() -> Result<(), FsError> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 3 {
        return Err(FsError::InvalidArgument(
            "mount.fuse3 invocation requires: openeral <source> <mountpoint> [-o options]"
                .to_string(),
        ));
    }

    let source = &args[1];
    let mount_arg = &args[2];

    let mount_mode = if let Some(fd_num) = parse_dev_fd(mount_arg) {
        info!(source = %source, fd = fd_num, "mount.fuse3 invocation (pre-opened fd)");
        MountMode::PreOpenedFd(claim_fuse_fd(fd_num)?)
    } else {
        info!(source = %source, mount_point = %mount_arg, "mount.fuse3 invocation (direct mount)");
        MountMode::MountPoint(PathBuf::from(mount_arg))
    };

    let options = parse_mount_options(&args[3..]);
    let (conn_str, workspace_id) = parse_source(source);

    if let Some(ws_id) = workspace_id {
        execute_workspace(conn_str, ws_id, mount_mode).await
    } else {
        execute_database(conn_str, options.read_only, mount_mode).await
    }
}

async fn execute_database(
    conn_str: String,
    read_only: bool,
    mount_mode: MountMode,
) -> Result<(), FsError> {
    let cli_arg = if conn_str.is_empty() {
        None
    } else {
        Some(conn_str.as_str())
    };
    let conn_str = resolve_connection_string(cli_arg, "OPENERAL_DATABASE_URL")?;

    let mount_point_str = match &mount_mode {
        MountMode::PreOpenedFd(_) => "(mount.fuse3)".to_string(),
        MountMode::MountPoint(p) => p.display().to_string(),
    };

    let config = MountConfig {
        connection_string: conn_str.clone(),
        mount_point: mount_point_str,
        schemas: None,
        read_only,
        cache_ttl: std::time::Duration::from_secs(30),
        page_size: 1000,
        statement_timeout_secs: 30,
    };

    info!("Creating connection pool");
    let pool = create_pool(&conn_str, config.statement_timeout_secs)?;

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
    info!("Connection verified");

    migrate::run_migrations(&pool).await?;

    let fs = PgmountFilesystem::new(pool, config, tokio::runtime::Handle::current());

    run_fuse_session(fs, mount_mode, read_only).await
}

async fn execute_workspace(
    conn_str: String,
    workspace_id: String,
    mount_mode: MountMode,
) -> Result<(), FsError> {
    let cli_arg = if conn_str.is_empty() {
        None
    } else {
        Some(conn_str.as_str())
    };
    let conn_str = resolve_connection_string(cli_arg, "OPENERAL_DATABASE_URL")?;
    let pool = create_pool(&conn_str, 30)?;

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

    migrate::run_migrations(&pool).await?;

    // Auto-create workspace if it doesn't exist (fstab mode doesn't have a separate create step)
    let ws = match ws_queries::get_workspace(&pool, &workspace_id).await {
        Ok(ws) => ws,
        Err(_) => {
            info!(workspace_id = %workspace_id, "Workspace not found, creating");
            let default_layout = crate::db::types::WorkspaceLayout::default();
            ws_queries::create_workspace(
                &pool,
                &workspace_id,
                Some(&workspace_id),
                &default_layout,
            )
            .await?;
            ws_queries::seed_from_config(&pool, &workspace_id, &default_layout).await?;
            ws_queries::get_workspace(&pool, &workspace_id).await?
        }
    };
    info!(workspace_id = %ws.id, "Workspace found");

    // Ensure seeded dirs exist
    ws_queries::seed_from_config(&pool, &workspace_id, &ws.config).await?;

    let mount_point_str = match &mount_mode {
        MountMode::PreOpenedFd(_) => "(mount.fuse3)".to_string(),
        MountMode::MountPoint(p) => p.display().to_string(),
    };

    let config = WorkspaceMountConfig {
        connection_string: conn_str,
        workspace_id: workspace_id.clone(),
        mount_point: mount_point_str,
        display_name: ws.display_name,
        statement_timeout_secs: 30,
    };

    let fs = WorkspaceFilesystem::new(pool, &config, tokio::runtime::Handle::current());

    info!(workspace_id = %workspace_id, "Starting workspace FUSE session");

    run_fuse_session(fs, mount_mode, false).await
}

/// Run the FUSE session — either from a pre-opened fd or by mounting directly.
async fn run_fuse_session<FS: fuser::Filesystem + Send + 'static>(
    fs: FS,
    mount_mode: MountMode,
    read_only: bool,
) -> Result<(), FsError> {
    match mount_mode {
        MountMode::PreOpenedFd(fuse_fd) => {
            info!("Starting FUSE session from pre-opened fd");
            let fuse_config = fuser::Config::default();

            let handle = tokio::task::spawn_blocking(move || {
                let session =
                    fuser::Session::from_fd(fs, fuse_fd, fuser::SessionACL::All, fuse_config)
                        .map_err(FsError::IoError)?;

                let _bg = session.spawn().map_err(FsError::IoError)?;

                // Block until the FUSE session ends (unmount or process exit)
                loop {
                    std::thread::park();
                }
            });

            handle
                .await
                .map_err(|e| FsError::InternalError(format!("FUSE session failed: {}", e)))?
        }
        MountMode::MountPoint(mount_point) => {
            info!(mount_point = %mount_point.display(), "Mounting filesystem");

            let mut fuse_config = fuser::Config::default();
            let mut mount_options = vec![
                fuser::MountOption::FSName("openeral".to_string()),
                fuser::MountOption::Subtype("openeral".to_string()),
                fuser::MountOption::DefaultPermissions,
            ];
            if read_only {
                mount_options.push(fuser::MountOption::RO);
            }
            fuse_config.mount_options = mount_options;
            fuse_config.acl = fuser::SessionACL::All;

            let handle = tokio::task::spawn_blocking(move || {
                fuser::mount2(fs, &mount_point, &fuse_config).map_err(FsError::IoError)
            });

            handle
                .await
                .map_err(|e| FsError::InternalError(format!("Mount failed: {}", e)))??;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_dev_fd() {
        assert_eq!(parse_dev_fd("/dev/fd/3"), Some(3));
        assert_eq!(parse_dev_fd("/dev/fd/0"), Some(0));
        assert_eq!(parse_dev_fd("/dev/fd/255"), Some(255));
        assert_eq!(parse_dev_fd("/dev/fd/"), None);
        assert_eq!(parse_dev_fd("/dev/fd/-1"), None);
        assert_eq!(parse_dev_fd("/dev/fd/abc"), None);
        assert_eq!(parse_dev_fd("/tmp/test"), None);
        assert_eq!(parse_dev_fd("/dev/fuse"), None);
    }

    #[test]
    fn test_detects_cli_subcommands_as_not_fuse_invocations() {
        for subcommand in KNOWN_SUBCOMMANDS {
            assert!(
                !is_fuse_fd_source_arg(Some(subcommand)),
                "{subcommand} should be treated as a CLI subcommand"
            );
        }
    }

    #[test]
    fn test_detects_mount_sources_as_fuse_invocations() {
        assert!(is_fuse_fd_source_arg(Some("env")));
        assert!(is_fuse_fd_source_arg(Some("env#workspace#abc")));
        assert!(is_fuse_fd_source_arg(Some("host=pg dbname=mydb")));
        assert!(!is_fuse_fd_source_arg(Some("--help")));
        assert!(!is_fuse_fd_source_arg(None));
    }

    #[test]
    fn test_parse_source_database() {
        let (conn, ws) = parse_source("host=pg dbname=mydb");
        assert_eq!(conn, "host=pg dbname=mydb");
        assert!(ws.is_none());
    }

    #[test]
    fn test_parse_source_workspace() {
        let (conn, ws) = parse_source("host=pg dbname=mydb#workspace#default");
        assert_eq!(conn, "host=pg dbname=mydb");
        assert_eq!(ws.unwrap(), "default");
    }

    #[test]
    fn test_parse_source_workspace_complex_id() {
        let (conn, ws) = parse_source("host=pg dbname=mydb#workspace#agent-42");
        assert_eq!(conn, "host=pg dbname=mydb");
        assert_eq!(ws.unwrap(), "agent-42");
    }

    #[test]
    fn test_parse_mount_options_ro() {
        let args = vec!["-o".to_string(), "ro,allow_other,noauto".to_string()];
        let opts = parse_mount_options(&args);
        assert!(opts.read_only);
    }

    #[test]
    fn test_parse_mount_options_rw() {
        let args = vec!["-o".to_string(), "rw,allow_other".to_string()];
        let opts = parse_mount_options(&args);
        assert!(!opts.read_only);
    }

    #[test]
    fn test_parse_mount_options_default() {
        let args: Vec<String> = vec![];
        let opts = parse_mount_options(&args);
        assert!(!opts.read_only); // default is rw
    }
}
