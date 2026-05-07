use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use clap::{Parser, ValueEnum};
use serde_json::{json, Map, Value};
use tracing::{info, warn};

use crate::error::FsError;

const BOOTSTRAP_ENV_PATH: &str = "/tmp/openeral-bootstrap.env";
const OPENERAL_ENV_REL: &str = ".openeral/env.sh";
const NPMRC_PATH: &str = "/tmp/openeral-npmrc";
const OPENCLAW_PORT: &str = "18789";

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum BootstrapPhase {
    /// Seed mounted home state and produce child environment additions.
    Prepare,
    /// Start runtime daemons that must inherit OpenShell sandbox networking.
    Runtime,
}

#[derive(Parser, Debug)]
pub struct BootstrapArgs {
    /// Bootstrap phase.
    #[arg(long, value_enum, default_value_t = BootstrapPhase::Prepare)]
    pub phase: BootstrapPhase,

    /// FUSE-backed agent home.
    #[arg(long, default_value = "/home/agent")]
    pub home: PathBuf,

    /// OpenShell connect-session home, usually /sandbox.
    #[arg(long, default_value = "/sandbox")]
    pub connect_home: PathBuf,

    /// File consumed by the OpenShell supervisor for child env additions.
    #[arg(long, default_value = BOOTSTRAP_ENV_PATH)]
    pub env_out: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentKind {
    Claude,
    OpenClaw,
}

pub async fn execute(args: BootstrapArgs) -> Result<(), FsError> {
    match args.phase {
        BootstrapPhase::Prepare => prepare(args),
        BootstrapPhase::Runtime => runtime(args),
    }
}

fn prepare(args: BootstrapArgs) -> Result<(), FsError> {
    let agent = agent_kind();
    fs::create_dir_all(&args.home)?;
    fs::create_dir_all(args.home.join(".openeral"))?;

    seed_agent_home(&args.home, agent)?;

    let stringcost_proxy_url = resolve_stringcost_proxy_url(&args.home, agent)?;
    if let Some(proxy_url) = &stringcost_proxy_url {
        apply_stringcost_to_home(&args.home, proxy_url, agent)?;
    }

    let mut child_env = BTreeMap::new();
    child_env.insert("HOME".to_string(), args.home.display().to_string());
    child_env.insert("OPENERAL_HOME".to_string(), args.home.display().to_string());
    child_env.insert("NODE_NO_WARNINGS".to_string(), "1".to_string());

    if let Some(proxy_url) = &stringcost_proxy_url {
        child_env.insert("ANTHROPIC_BASE_URL".to_string(), proxy_url.clone());
        child_env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), "dummy".to_string());
        child_env.insert(
            "OPENERAL_STRINGCOST_PROXY_URL".to_string(),
            proxy_url.clone(),
        );
    }

    if std::env::var_os("SOCKET_TOKEN").is_some() {
        configure_socket_npmrc()?;
        child_env.insert("NPM_CONFIG_USERCONFIG".to_string(), NPMRC_PATH.to_string());
    }

    if agent == AgentKind::OpenClaw {
        child_env.insert("OPENCLAW_SKIP_ONBOARDING".to_string(), "1".to_string());
        child_env.insert(
            "OPENCLAW_HANDSHAKE_TIMEOUT_MS".to_string(),
            "30000".to_string(),
        );
    }

    write_shell_env(&args.home, &child_env)?;
    if let Err(error) = write_connect_bashrc(&args.connect_home, &args.home) {
        warn!(
            path = %args.connect_home.display(),
            error = %error,
            "could not seed OpenShell connect shell rc; continuing with child environment"
        );
    }
    write_bootstrap_env(&args.env_out, &child_env)?;

    info!(phase = "prepare", "openeral bootstrap complete");
    Ok(())
}

fn runtime(args: BootstrapArgs) -> Result<(), FsError> {
    if agent_kind() != AgentKind::OpenClaw {
        return Ok(());
    }

    write_openclaw_config(
        &args.home,
        std::env::var("OPENERAL_STRINGCOST_PROXY_URL")
            .ok()
            .filter(|v| !v.is_empty())
            .as_deref(),
    )?;

    if find_command("openclaw").is_none() {
        warn!("OpenClaw selected but openclaw is not installed in the sandbox image");
        return Ok(());
    }

    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/openclaw-gateway.log")?;
    let err = log.try_clone()?;

    let mut child = Command::new("openclaw")
        .arg("gateway")
        .arg("--port")
        .arg(OPENCLAW_PORT)
        .arg("--allow-unconfigured")
        .env("HOME", &args.home)
        .env("OPENCLAW_SKIP_ONBOARDING", "1")
        .env("OPENCLAW_HANDSHAKE_TIMEOUT_MS", "30000")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| {
            FsError::IoError(std::io::Error::new(
                e.kind(),
                format!("failed to start openclaw gateway: {e}"),
            ))
        })?;

    let ready = wait_for_openclaw_ready(Duration::from_secs(300));
    if ready {
        info!(pid = child.id(), "OpenClaw gateway ready");
        write_openclaw_config(
            &args.home,
            std::env::var("OPENERAL_STRINGCOST_PROXY_URL")
                .ok()
                .filter(|v| !v.is_empty())
                .as_deref(),
        )?;
    } else {
        warn!(
            pid = child.id(),
            "OpenClaw gateway was not ready within timeout"
        );
        let _ = child.kill();
    }

    Ok(())
}

fn agent_kind() -> AgentKind {
    match std::env::var("OPENERAL_AGENT") {
        Ok(value) if value == "openclaw" || value.starts_with("openshell:resolve:env:") => {
            AgentKind::OpenClaw
        }
        _ => AgentKind::Claude,
    }
}

fn seed_agent_home(home: &Path, agent: AgentKind) -> Result<(), FsError> {
    fs::create_dir_all(home.join(".openeral"))?;
    match agent {
        AgentKind::Claude => {
            fs::create_dir_all(home.join(".claude/projects"))?;
            let settings = home.join(".claude/settings.json");
            if !settings.exists() {
                write_json_file(&settings, &default_claude_settings())?;
            }
        }
        AgentKind::OpenClaw => {
            fs::create_dir_all(home.join(".openclaw"))?;
        }
    }
    Ok(())
}

fn default_claude_settings() -> Value {
    json!({
        "permissions": {
            "allow": [
                "Bash(npm run *)",
                "Bash(npm test *)",
                "Bash(git status)",
                "Bash(git diff *)",
                "Bash(git log *)",
                "Bash(git commit *)",
                "Bash(ls *)",
                "Bash(cat *)",
                "Bash(grep *)"
            ],
            "deny": [
                "Read(~/.ssh/**)",
                "Read(~/.aws/**)",
                "Read(~/.azure/**)",
                "Read(~/.npmrc)",
                "Read(~/.git-credentials)",
                "Edit(~/.bashrc)",
                "Edit(~/.zshrc)",
                "Bash(curl *)",
                "Bash(wget *)",
                "Bash(nc *)",
                "Bash(ssh *)",
                "Bash(git push *)",
                "Read(*.env)",
                "Read(.env.*)"
            ]
        },
        "enableAllProjectMcpServers": false
    })
}

fn resolve_stringcost_proxy_url(home: &Path, agent: AgentKind) -> Result<Option<String>, FsError> {
    if let Ok(url) = std::env::var("STRINGCOST_PROXY_URL") {
        if let Some(normalized) = normalize_stringcost_proxy_url(&url) {
            store_stringcost_presign(home, agent, &normalized)?;
            return Ok(Some(normalized));
        }
    }

    let presign_file = stringcost_presign_file(home, agent);
    if let Ok(raw) = fs::read_to_string(&presign_file) {
        if let Some(url) = parse_presign_url(&raw).and_then(|u| normalize_stringcost_proxy_url(&u))
        {
            return Ok(Some(url));
        }
    }

    if std::env::var_os("STRINGCOST_API_KEY").is_some()
        && std::env::var_os("ANTHROPIC_API_KEY").is_some()
    {
        if let Some(url) = create_stringcost_presign(&presign_file, agent)? {
            return Ok(Some(url));
        }
    }

    Ok(None)
}

fn stringcost_presign_file(home: &Path, agent: AgentKind) -> PathBuf {
    match agent {
        AgentKind::Claude => home.join(".openeral/presign.json"),
        AgentKind::OpenClaw => home.join(".openeral/presign-openclaw.json"),
    }
}

fn parse_presign_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') {
        serde_json::from_str::<Value>(trimmed)
            .ok()
            .and_then(|value| value.get("url").and_then(Value::as_str).map(str::to_string))
    } else if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_stringcost_proxy_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let start = trimmed
        .find("https://")
        .or_else(|| trimmed.find("http://"))
        .unwrap_or(0);
    let candidate = trimmed[start..]
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let without_api_path = candidate
        .split_once("/v1/")
        .map_or(candidate, |(base, _)| base)
        .trim_end_matches('/');
    if without_api_path.starts_with("http") && without_api_path.contains("/stringcost-proxy/t/") {
        Some(without_api_path.to_string())
    } else {
        None
    }
}

fn store_stringcost_presign(home: &Path, agent: AgentKind, url: &str) -> Result<(), FsError> {
    let file = stringcost_presign_file(home, agent);
    let value = json!({
        "url": url,
        "created_at": chrono::Utc::now().to_rfc3339(),
    });
    write_json_file(&file, &value)
}

fn create_stringcost_presign(
    presign_file: &Path,
    agent: AgentKind,
) -> Result<Option<String>, FsError> {
    if find_command("node").is_none() {
        warn!("node is unavailable; skipping StringCost presign creation");
        return Ok(None);
    }

    if let Some(parent) = presign_file.parent() {
        fs::create_dir_all(parent)?;
    }

    let label = match agent {
        AgentKind::Claude => "claude-code",
        AgentKind::OpenClaw => "openclaw",
    };
    let script = r#"
const fs = require('fs');
(async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const apiBase = (process.env.STRINGCOST_API_BASE || 'https://app.stringcost.com').replace(/\/+$/, '');
    const r = await fetch(apiBase + '/v1/presign', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.STRINGCOST_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        client_api_key: process.env.ANTHROPIC_API_KEY,
        path: ['/v1/messages'],
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10000000,
        metadata: {
          source: 'openeral-sandbox',
          client: process.argv[2],
          labels: ['openeral', process.argv[2]],
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error('presign failed (' + r.status + '): ' + await r.text());
    const d = await r.json();
    if (!d || !d.url) throw new Error('presign returned no URL');
    fs.writeFileSync(process.argv[1], JSON.stringify({ url: d.url, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(d.url);
  } catch (err) {
    clearTimeout(timeout);
    process.stderr.write((err && err.message) || String(err));
    process.exit(1);
  }
})();
"#;

    let output = Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(presign_file)
        .arg(label)
        .env("NODE_NO_WARNINGS", "1")
        .output()?;

    if !output.status.success() {
        warn!(
            detail = %String::from_utf8_lossy(&output.stderr),
            "StringCost presign creation failed; continuing without proxy"
        );
        return Ok(None);
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    Ok(normalize_stringcost_proxy_url(&raw))
}

fn apply_stringcost_to_home(home: &Path, proxy_url: &str, agent: AgentKind) -> Result<(), FsError> {
    match agent {
        AgentKind::Claude => {
            let settings = home.join(".claude/settings.json");
            let mut value = read_json_file(&settings).unwrap_or_else(default_claude_settings);
            let object = ensure_object(&mut value);
            let env = object
                .entry("env".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            let env_obj = ensure_object(env);
            env_obj.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                Value::String(proxy_url.to_string()),
            );
            env_obj.insert(
                "ANTHROPIC_AUTH_TOKEN".to_string(),
                Value::String("dummy".to_string()),
            );
            env_obj.remove("ANTHROPIC_API_KEY");
            write_json_file(&settings, &value)
        }
        AgentKind::OpenClaw => write_openclaw_config(home, Some(proxy_url)),
    }
}

fn write_openclaw_config(home: &Path, proxy_url: Option<&str>) -> Result<(), FsError> {
    let file = home.join(".openclaw/openclaw.json");
    let mut config = read_json_file(&file).unwrap_or_else(|| json!({}));
    let root = ensure_object(&mut config);

    let env = root
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let env = ensure_object(env);
    if let Some(url) = proxy_url {
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            Value::String(url.to_string()),
        );
        env.insert(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            Value::String("dummy".to_string()),
        );
        env.remove("ANTHROPIC_API_KEY");
    } else if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
        env.insert(
            "ANTHROPIC_API_KEY".to_string(),
            Value::String(placeholder_for("ANTHROPIC_API_KEY")),
        );
        env.remove("ANTHROPIC_BASE_URL");
        env.remove("ANTHROPIC_AUTH_TOKEN");
    }

    let gateway = root
        .entry("gateway".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let gateway = ensure_object(gateway);
    gateway
        .entry("mode".to_string())
        .or_insert_with(|| Value::String("local".to_string()));
    gateway
        .entry("handshakeTimeoutMs".to_string())
        .or_insert_with(|| Value::Number(30000.into()));

    let agents = root
        .entry("agents".to_string())
        .or_insert_with(|| json!({ "defaults": { "model": {} } }));
    let defaults = ensure_object(agents)
        .entry("defaults".to_string())
        .or_insert_with(|| json!({ "model": {} }));
    let model = ensure_object(defaults)
        .entry("model".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    ensure_object(model)
        .entry("primary".to_string())
        .or_insert_with(|| Value::String("anthropic/claude-sonnet-4-6".to_string()));

    write_json_file(&file, &config)
}

fn configure_socket_npmrc() -> Result<(), FsError> {
    let token = placeholder_for("SOCKET_TOKEN");
    let content = format!(
        "registry=https://registry.socket.dev/npm/\n//registry.socket.dev/npm/:_authToken={token}\n"
    );
    fs::write(NPMRC_PATH, content)?;
    Ok(())
}

fn write_shell_env(home: &Path, env: &BTreeMap<String, String>) -> Result<(), FsError> {
    let file = home.join(OPENERAL_ENV_REL);
    let mut content = String::new();
    for (key, value) in env {
        content.push_str("export ");
        content.push_str(key);
        content.push('=');
        content.push_str(&shell_quote(value));
        content.push('\n');
    }
    if env.contains_key("ANTHROPIC_BASE_URL") {
        content.push_str("unset ANTHROPIC_API_KEY\n");
    }
    fs::write(file, content)?;
    Ok(())
}

fn write_connect_bashrc(connect_home: &Path, home: &Path) -> Result<(), FsError> {
    if connect_home == home {
        return Ok(());
    }
    fs::create_dir_all(connect_home)?;
    let bashrc = connect_home.join(".bashrc");
    let marker = "openeral-connect";
    let existing = fs::read_to_string(&bashrc).unwrap_or_default();
    if existing.contains(marker) {
        return Ok(());
    }
    let mut file = OpenOptions::new().create(true).append(true).open(bashrc)?;
    writeln!(
        file,
        "\n# {marker}: set agent HOME for OpenShell reconnect sessions\nexport HOME={}\n[ -f /home/agent/.openeral/env.sh ] && . /home/agent/.openeral/env.sh",
        shell_quote(&home.display().to_string())
    )?;
    Ok(())
}

fn write_bootstrap_env(path: &Path, env: &BTreeMap<String, String>) -> Result<(), FsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut content = String::new();
    for (key, value) in env {
        if value.contains('\n') || value.contains('\0') {
            return Err(FsError::InvalidArgument(format!(
                "bootstrap env value for {key} contains unsupported control characters"
            )));
        }
        content.push_str(key);
        content.push('=');
        content.push_str(value);
        content.push('\n');
    }
    fs::write(path, content)?;
    Ok(())
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), FsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| FsError::SerializationError(e.to_string()))?;
    fs::write(path, bytes)?;
    Ok(())
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value was just made object")
}

fn placeholder_for(key: &str) -> String {
    format!("openshell:resolve:env:{key}")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn find_command(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let full = dir.join(name);
            if full.is_file() {
                Some(full)
            } else {
                None
            }
        })
    })
}

fn wait_for_openclaw_ready(timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        let ready = Command::new("curl")
            .arg("-fsS")
            .arg(format!("http://127.0.0.1:{OPENCLAW_PORT}/readyz"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if ready {
            return true;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_stringcost_url_strips_api_path() {
        assert_eq!(
            normalize_stringcost_proxy_url(
                "https://proxy.stringcost.com/stringcost-proxy/t/abc/v1/messages"
            )
            .unwrap(),
            "https://proxy.stringcost.com/stringcost-proxy/t/abc"
        );
    }

    #[test]
    fn socket_npmrc_uses_placeholder_token() {
        let token = placeholder_for("SOCKET_TOKEN");
        assert_eq!(token, "openshell:resolve:env:SOCKET_TOKEN");
    }
}
