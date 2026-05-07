// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! FUSE filesystem support via `/etc/fstab` inspection.
//!
//! The supervisor reads `/etc/fstab` from the container image at startup. Any
//! `fuse.*` entries with the `noauto` flag are mounted before the child
//! process is spawned.

use miette::{IntoDiagnostic, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::policy::SandboxPolicy;

/// A FUSE mount discovered from `/etc/fstab`.
#[derive(Debug)]
pub struct FuseMount {
    pub source: String,
    pub mount_point: PathBuf,
    pub binary: String,
    pub options: String,
    pub read_only: bool,
}

/// Parse `/etc/fstab` for supervisor-managed FUSE mount entries.
pub fn discover_fuse_mounts() -> Vec<FuseMount> {
    let content = match std::fs::read_to_string("/etc/fstab") {
        Ok(content) => content,
        Err(error) => {
            debug!(error = %error, "No /etc/fstab, skipping FUSE discovery");
            return Vec::new();
        }
    };

    let mut mounts = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }

        let source = fields[0];
        let mount_point = fields[1];
        let fs_type = fields[2];
        let options = fields[3];

        let binary = match fs_type.strip_prefix("fuse.") {
            Some(binary) if !binary.is_empty() => binary,
            _ => continue,
        };

        if !options.split(',').any(|option| option == "noauto") {
            continue;
        }

        if which_binary(binary).is_none() && find_binary_in_common_paths(binary).is_none() {
            warn!(
                binary = binary,
                mount_point = mount_point,
                "FUSE binary not found, skipping"
            );
            continue;
        }

        let source = source.trim_matches('"').trim_matches('\'');
        let read_only = options.split(',').any(|option| option == "ro");

        info!(
            fs_type = fs_type,
            source = source,
            mount_point = mount_point,
            "Discovered FUSE mount"
        );

        mounts.push(FuseMount {
            source: source.to_string(),
            mount_point: PathBuf::from(mount_point),
            binary: binary.to_string(),
            options: options.to_string(),
            read_only,
        });
    }

    mounts
}

/// Verify `/dev/fuse` is available.
pub fn ensure_fuse_device() -> Result<()> {
    let path = Path::new("/dev/fuse");
    if path.exists() {
        info!("/dev/fuse available");
        Ok(())
    } else {
        Err(miette::miette!(
            "/dev/fuse not found. For the Docker compute driver, start the \
             openeral gateway with OPENSHELL_DOCKER_FUSE_DEVICE=/dev/fuse so \
             sandbox containers receive the host FUSE device."
        ))
    }
}

fn find_mount_fuse3() -> Option<PathBuf> {
    for path in &[
        "/sbin/mount.fuse3",
        "/usr/sbin/mount.fuse3",
        "/bin/mount.fuse3",
        "/usr/bin/mount.fuse3",
    ] {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    which_binary("mount.fuse3")
}

fn expand_source_placeholders(source: &str, env: &HashMap<String, String>) -> Result<String> {
    let mut expanded = String::with_capacity(source.len());
    let mut rest = source;

    while let Some(start) = rest.find("${") {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            return Err(miette::miette!(
                "FUSE mount source `{source}` has an unterminated placeholder"
            ));
        };

        let key = &after[..end];
        if key.is_empty() {
            return Err(miette::miette!(
                "FUSE mount source `{source}` has an empty placeholder"
            ));
        }

        let value = env.get(key).ok_or_else(|| {
            miette::miette!(
                "FUSE mount source `{source}` references missing environment variable `{key}`"
            )
        })?;
        expanded.push_str(value);
        rest = &after[end + 1..];
    }

    expanded.push_str(rest);
    Ok(expanded)
}

/// Spawn a FUSE daemon via `mount.fuse3`.
pub fn spawn_fuse_mount(mount: &FuseMount, env: &HashMap<String, String>) -> Result<Child> {
    let mount_fuse3 = find_mount_fuse3().ok_or_else(|| miette::miette!("mount.fuse3 not found"))?;
    let source = expand_source_placeholders(&mount.source, env)?;

    info!(
        binary = %mount.binary,
        source = %source,
        mount_point = %mount.mount_point.display(),
        "Spawning FUSE daemon"
    );

    let type_source = format!("{}#{}", mount.binary, source);

    let mut cmd = Command::new(mount_fuse3);
    cmd.arg(&type_source);
    cmd.arg(&mount.mount_point);
    cmd.arg("-o");
    cmd.arg(&mount.options);
    cmd.current_dir("/");

    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.env("HOME", "/tmp");
    cmd.env(
        "RUST_LOG",
        env.get("RUST_LOG")
            .map_or("openeral=info,openeral_core=info,warn", String::as_str),
    );

    let child = cmd.spawn().into_diagnostic()?;
    info!(
        pid = child.id(),
        mount_point = %mount.mount_point.display(),
        "FUSE daemon spawned"
    );
    Ok(child)
}

fn exited_status_message(status: ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("exit code {code}"),
        None => "terminated by signal".to_string(),
    }
}

pub fn wait_for_mount(path: &Path, child: &mut Child, timeout: Duration) -> Result<()> {
    let start = std::time::Instant::now();
    let mut child_exited = false;
    while start.elapsed() < timeout {
        if is_mountpoint(path) {
            info!(path = %path.display(), "FUSE mount ready");
            return Ok(());
        }
        if !child_exited {
            match child.try_wait() {
                Ok(Some(status)) => {
                    child_exited = true;
                    if !status.success() {
                        return Err(miette::miette!(
                            "FUSE daemon for {} exited before mount became ready ({})",
                            path.display(),
                            exited_status_message(status)
                        ));
                    }
                    warn!(
                        path = %path.display(),
                        status = %exited_status_message(status),
                        "FUSE mount helper exited before mountpoint appeared; waiting for daemonized child"
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(
                        path = %path.display(),
                        error = %error,
                        "Could not poll FUSE daemon status while waiting for mount"
                    );
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(miette::miette!(
        "FUSE mount at {} not ready within {:?}",
        path.display(),
        timeout
    ))
}

fn is_mountpoint(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    std::fs::read_to_string("/proc/mounts")
        .ok()
        .map(|content| {
            content
                .lines()
                .any(|line| line.split_whitespace().nth(1) == Some(path_str.as_ref()))
        })
        .unwrap_or(false)
}

fn which_binary(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let full = dir.join(name);
            if full.is_file() { Some(full) } else { None }
        })
    })
}

fn find_binary_in_common_paths(name: &str) -> Option<PathBuf> {
    for dir in &[
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/local/sbin",
        "/usr/sbin",
        "/sbin",
    ] {
        let full = PathBuf::from(dir).join(name);
        if full.is_file() {
            return Some(full);
        }
    }
    None
}

/// Discover, spawn, wait, and update the sandbox filesystem policy.
pub fn setup_fuse_mounts(
    policy: &mut SandboxPolicy,
    env: &HashMap<String, String>,
) -> Result<Vec<Child>> {
    let mounts = discover_fuse_mounts();
    if mounts.is_empty() {
        return Ok(Vec::new());
    }

    info!(
        count = mounts.len(),
        "Setting up FUSE mounts from /etc/fstab"
    );
    ensure_fuse_device()?;

    let mut fuse_env = env.clone();
    for key in &[
        "DATABASE_URL",
        "OPENERAL_DATABASE_URL",
        "ANTHROPIC_API_KEY",
        "OPENSHELL_SANDBOX_ID",
        "OPENSHELL_SANDBOX",
    ] {
        if !fuse_env.contains_key(*key)
            && let Ok(value) = std::env::var(key)
        {
            fuse_env.insert((*key).to_string(), value);
        }
    }

    if !fuse_env.contains_key("OPENERAL_DATABASE_URL")
        && let Some(db_url) = fuse_env.get("DATABASE_URL")
    {
        info!("Mapping DATABASE_URL to OPENERAL_DATABASE_URL");
        fuse_env.insert("OPENERAL_DATABASE_URL".to_string(), db_url.clone());
    }

    if !fuse_env.contains_key("OPENERAL_DATABASE_URL") {
        return Err(miette::miette!(
            "FUSE mounts declared in /etc/fstab but no DATABASE_URL or \
             OPENERAL_DATABASE_URL is available. Create an OpenShell generic \
             provider containing DATABASE_URL."
        ));
    }

    let timeout = Duration::from_secs(30);
    let mut daemons = Vec::new();

    for mount in &mounts {
        expand_source_placeholders(&mount.source, &fuse_env)?;
    }

    for mount in &mounts {
        if !mount.mount_point.exists() {
            std::fs::create_dir_all(&mount.mount_point).into_diagnostic()?;
        }

        let mut child = spawn_fuse_mount(mount, &fuse_env)?;
        wait_for_mount(&mount.mount_point, &mut child, timeout)?;
        daemons.push(child);

        if mount.read_only {
            policy.filesystem.read_only.push(mount.mount_point.clone());
        } else {
            policy.filesystem.read_write.push(mount.mount_point.clone());
        }
    }

    policy
        .filesystem
        .read_write
        .push(PathBuf::from("/dev/fuse"));
    info!(count = daemons.len(), "All FUSE mounts ready");
    Ok(daemons)
}

#[cfg(test)]
mod tests {
    use super::expand_source_placeholders;
    use std::collections::HashMap;

    #[test]
    fn expand_source_placeholders_leaves_literal_source_unchanged() {
        let env = HashMap::new();
        let source = "env#workspace#literal";

        assert_eq!(
            expand_source_placeholders(source, &env).unwrap(),
            "env#workspace#literal"
        );
    }

    #[test]
    fn expand_source_placeholders_substitutes_environment_variables() {
        let env = HashMap::from([(
            "OPENSHELL_SANDBOX_ID".to_string(),
            "sandbox-123".to_string(),
        )]);
        let source = "env#workspace#${OPENSHELL_SANDBOX_ID}";

        assert_eq!(
            expand_source_placeholders(source, &env).unwrap(),
            "env#workspace#sandbox-123"
        );
    }

    #[test]
    fn expand_source_placeholders_errors_on_missing_variable() {
        let env = HashMap::new();
        let source = "env#workspace#${OPENSHELL_SANDBOX_ID}";

        let err = expand_source_placeholders(source, &env).unwrap_err();
        assert!(err.to_string().contains("OPENSHELL_SANDBOX_ID"));
    }
}
