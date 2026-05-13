pub mod bootstrap;
pub mod fuse_fd;
pub mod list;
pub mod memory;
pub mod migrate;
pub mod mount;
pub mod optimize;
pub mod session;
pub mod unmount;
pub mod version;
pub mod workspace;

use crate::error::FsError;
use clap::{Parser, Subcommand};

pub use fuse_fd::is_fuse_fd_invocation;

#[derive(Parser)]
#[command(
    name = "openeral",
    about = "Mount PostgreSQL databases as virtual filesystems"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Prepare an OpenShell sandbox after FUSE mounts are ready
    Bootstrap(bootstrap::BootstrapArgs),
    /// Mount a PostgreSQL database
    Mount(mount::MountArgs),
    /// Run pending database migrations
    Migrate(migrate::MigrateArgs),
    /// Manage Claude memory files in the FUSE-backed home
    Memory(memory::MemoryArgs),
    /// Inspect optimization metrics stored in PostgreSQL
    Optimize(optimize::OptimizeArgs),
    /// Prepare /sandbox and exec the requested agent command
    Session(session::SessionArgs),
    /// Unmount a previously mounted database
    Unmount(unmount::UnmountArgs),
    /// List active mounts
    List,
    /// Show version information
    Version,
    /// Manage workspaces (create, mount, seed, list, delete)
    Workspace(workspace::WorkspaceArgs),
}

pub async fn run() -> Result<(), FsError> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Bootstrap(args) => bootstrap::execute(args).await,
        Commands::Mount(args) => mount::execute(args).await,
        Commands::Migrate(args) => migrate::execute(args).await,
        Commands::Memory(args) => memory::execute(args).await,
        Commands::Optimize(args) => optimize::execute(args).await,
        Commands::Session(args) => session::execute(args).await,
        Commands::Unmount(args) => unmount::execute(args).await,
        Commands::List => list::execute().await,
        Commands::Version => {
            version::execute();
            Ok(())
        }
        Commands::Workspace(args) => workspace::execute(args).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn test_parse_migrate_subcommand() {
        let cli = Cli::try_parse_from(["openeral", "migrate"]).unwrap();
        assert!(matches!(cli.command, Commands::Migrate(_)));
    }
}
