use clap::{Parser, Subcommand};

use crate::db::pool::create_pool;
use crate::error::FsError;

#[derive(Parser, Debug)]
pub struct OptimizeArgs {
    #[command(subcommand)]
    pub command: OptimizeCommand,
}

#[derive(Subcommand, Debug)]
pub enum OptimizeCommand {
    /// Show aggregate optimization metrics for the current backing store.
    Stats,
}

pub async fn execute(args: OptimizeArgs) -> Result<(), FsError> {
    match args.command {
        OptimizeCommand::Stats => stats().await,
    }
}

async fn stats() -> Result<(), FsError> {
    let Some(database_url) = std::env::var("OPENERAL_DATABASE_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("DATABASE_URL")
                .ok()
                .filter(|value| !value.is_empty())
        })
    else {
        println!("No OPENERAL_DATABASE_URL or DATABASE_URL is available for optimization stats.");
        return Ok(());
    };

    let pool = create_pool(&database_url, 5)?;
    let client = pool
        .get()
        .await
        .map_err(|e| FsError::DatabaseError(format!("Failed to get connection: {e}")))?;
    let row = client
        .query_one(
            "SELECT COUNT(*)::BIGINT AS count, \
                    COALESCE(SUM(tokens_saved), 0)::BIGINT AS tokens_saved, \
                    COALESCE(SUM(cost_saved), 0)::TEXT AS cost_saved \
             FROM _openeral.optimization_metrics",
            &[],
        )
        .await?;
    let count: i64 = row.get("count");
    let tokens_saved: i64 = row.get("tokens_saved");
    let cost_saved: String = row.get("cost_saved");

    println!("Optimization metrics");
    println!("  rows: {count}");
    println!("  tokens_saved: {tokens_saved}");
    println!("  cost_saved: {cost_saved}");
    Ok(())
}
