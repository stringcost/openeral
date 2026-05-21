use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use clap::Args;

use crate::error::FsError;

#[derive(Args, Debug)]
pub struct SessionArgs {
    /// Local agent home used by the child process.
    #[arg(long, default_value = "/home/agent")]
    pub home: PathBuf,

    /// Durable reconnect shell home.
    #[arg(long, default_value = "/sandbox")]
    pub connect_home: PathBuf,

    /// Default working directory for the child process.
    #[arg(long, default_value = "/sandbox/project")]
    pub connect_cwd: PathBuf,

    /// Command to execute after preparing the session environment.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
    pub command: Vec<String>,
}

pub async fn execute(args: SessionArgs) -> Result<(), FsError> {
    let env_out = std::env::temp_dir().join("openeral-session.env");
    crate::cli::bootstrap::execute(crate::cli::bootstrap::BootstrapArgs {
        phase: crate::cli::bootstrap::BootstrapPhase::Prepare,
        home: args.home.clone(),
        connect_home: args.connect_home.clone(),
        connect_cwd: args.connect_cwd.clone(),
        env_out: env_out.clone(),
    })
    .await?;

    if should_start_runtime(&args.command) {
        crate::cli::bootstrap::execute(crate::cli::bootstrap::BootstrapArgs {
            phase: crate::cli::bootstrap::BootstrapPhase::Runtime,
            home: args.home.clone(),
            connect_home: args.connect_home.clone(),
            connect_cwd: args.connect_cwd.clone(),
            env_out: env_out.clone(),
        })
        .await?;
    }

    let extra_env = read_env_file(&env_out)?;
    let program = args
        .command
        .first()
        .ok_or_else(|| FsError::InvalidArgument("session command is required".to_string()))?;
    let command_args = &args.command[1..];

    let status = Command::new(program)
        .args(command_args)
        .envs(extra_env)
        .current_dir(&args.connect_cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(FsError::IoError)?;

    match status.code() {
        Some(code) => {
            std::process::exit(code);
        }
        None => Err(FsError::InternalError(
            "session child terminated by signal".to_string(),
        )),
    }
}

fn read_env_file(path: &PathBuf) -> Result<BTreeMap<String, String>, FsError> {
    let raw = std::fs::read_to_string(path).map_err(FsError::IoError)?;
    let mut env = BTreeMap::new();
    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line.split_once('=').ok_or_else(|| {
            FsError::InvalidArgument(format!("invalid bootstrap env line: {line}"))
        })?;
        env.insert(key.to_string(), value.to_string());
    }
    Ok(env)
}

fn should_start_runtime(command: &[String]) -> bool {
    command
        .first()
        .is_some_and(|cmd| cmd.ends_with("openclaw") || cmd == "openclaw")
        || std::env::var("OPENERAL_AGENT")
            .map(|value| value == "openclaw" || value.starts_with("openshell:resolve:env:"))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_openclaw_runtime_from_command() {
        assert!(should_start_runtime(&["openclaw".to_string()]));
        assert!(should_start_runtime(&[
            "/usr/local/bin/openclaw".to_string()
        ]));
        assert!(!should_start_runtime(&["claude".to_string()]));
    }
}
