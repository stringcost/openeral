use std::collections::HashMap;
use std::fs;
use std::net::IpAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::Arc;

use clap::{Args, Parser, Subcommand};
use openeral_core::config::types::WorkspaceMountConfig;
use openeral_core::db::migrate;
use openeral_core::db::pool::create_pool;
use openeral_core::db::queries::workspace as ws_queries;
use openeral_core::db::types::WorkspaceLayout;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::net::UnixListener;
use tokio::sync::Mutex;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::metadata::MetadataValue;
use tonic::service::interceptor::InterceptedService;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity, Server};
use tonic::{Request, Response, Status};
use tracing::{error, info};

mod csi {
    tonic::include_proto!("csi.v1");
}

mod openshell {
    tonic::include_proto!("openshell.v1");
}

const DRIVER_NAME: &str = "csi.openeral.io";
const VENDOR_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_ENDPOINT: &str = "/csi/csi.sock";
const DEFAULT_GATEWAY_ENDPOINT: &str = "https://openshell.openshell.svc.cluster.local:8080";
const DEFAULT_SANDBOX_UID: i32 = 998;
const DEFAULT_SANDBOX_GID: i32 = 998;

#[derive(Parser, Debug)]
#[command(name = "openeral-csi", about = "Openeral CSI plugin")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the CSI node service.
    Node(NodeArgs),
    /// Run the CSI controller service.
    Controller(ControllerArgs),
}

#[derive(Args, Debug)]
struct NodeArgs {
    /// Unix-domain socket path to listen on.
    #[arg(long, default_value = DEFAULT_ENDPOINT)]
    endpoint: PathBuf,

    /// OpenShell gRPC endpoint reachable from the cluster.
    #[arg(long, default_value = DEFAULT_GATEWAY_ENDPOINT)]
    gateway_endpoint: String,
}

#[derive(Args, Debug)]
struct ControllerArgs {
    /// Unix-domain socket path to listen on.
    #[arg(long, default_value = DEFAULT_ENDPOINT)]
    endpoint: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    match cli.command {
        Commands::Node(args) => run_node(args).await?,
        Commands::Controller(args) => run_controller(args).await?,
    }
    Ok(())
}

async fn run_node(args: NodeArgs) -> Result<(), Box<dyn std::error::Error>> {
    let listener = bind_uds(&args.endpoint).await?;
    let gateway_endpoint = std::env::var("OPENSHELL_ENDPOINT")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or(args.gateway_endpoint);
    let service = NodeServiceImpl::new(gateway_endpoint);

    info!(socket = %args.endpoint.display(), "Starting Openeral CSI node service");
    Server::builder()
        .add_service(csi::identity_server::IdentityServer::new(service.clone()))
        .add_service(csi::node_server::NodeServer::new(service))
        .serve_with_incoming(UnixListenerStream::new(listener))
        .await?;
    Ok(())
}

async fn run_controller(args: ControllerArgs) -> Result<(), Box<dyn std::error::Error>> {
    let listener = bind_uds(&args.endpoint).await?;
    let service = ControllerServiceImpl;

    info!(
        socket = %args.endpoint.display(),
        "Starting Openeral CSI controller service"
    );
    Server::builder()
        .add_service(csi::identity_server::IdentityServer::new(service.clone()))
        .add_service(csi::controller_server::ControllerServer::new(service))
        .serve_with_incoming(UnixListenerStream::new(listener))
        .await?;
    Ok(())
}

async fn bind_uds(path: &Path) -> Result<UnixListener, Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.exists() {
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o777))?;
    Ok(listener)
}

#[derive(Clone)]
struct ControllerServiceImpl;

#[derive(Clone)]
struct NodeServiceImpl {
    gateway_endpoint: String,
    node_id: String,
    mounted_targets: Arc<Mutex<HashMap<String, String>>>,
}

impl NodeServiceImpl {
    fn new(gateway_endpoint: String) -> Self {
        let node_id = std::env::var("OPENSHELL_NODE_NAME")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                std::env::var("HOSTNAME").unwrap_or_else(|_| "openeral-node".to_string())
            });
        Self {
            gateway_endpoint,
            node_id,
            mounted_targets: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tonic::async_trait]
impl csi::identity_server::Identity for ControllerServiceImpl {
    async fn get_plugin_info(
        &self,
        _request: Request<csi::GetPluginInfoRequest>,
    ) -> Result<Response<csi::GetPluginInfoResponse>, Status> {
        Ok(Response::new(csi::GetPluginInfoResponse {
            name: DRIVER_NAME.to_string(),
            vendor_version: VENDOR_VERSION.to_string(),
            manifest: HashMap::new(),
        }))
    }

    async fn get_plugin_capabilities(
        &self,
        _request: Request<csi::GetPluginCapabilitiesRequest>,
    ) -> Result<Response<csi::GetPluginCapabilitiesResponse>, Status> {
        Ok(Response::new(csi::GetPluginCapabilitiesResponse {
            capabilities: vec![csi::PluginCapability {
                r#type: Some(csi::plugin_capability::Type::Service(
                    csi::plugin_capability::Service {
                        r#type: csi::plugin_capability::service::Type::ControllerService as i32,
                    },
                )),
            }],
        }))
    }

    async fn probe(
        &self,
        _request: Request<csi::ProbeRequest>,
    ) -> Result<Response<csi::ProbeResponse>, Status> {
        Ok(Response::new(csi::ProbeResponse { ready: None }))
    }
}

#[tonic::async_trait]
impl csi::identity_server::Identity for NodeServiceImpl {
    async fn get_plugin_info(
        &self,
        _request: Request<csi::GetPluginInfoRequest>,
    ) -> Result<Response<csi::GetPluginInfoResponse>, Status> {
        Ok(Response::new(csi::GetPluginInfoResponse {
            name: DRIVER_NAME.to_string(),
            vendor_version: VENDOR_VERSION.to_string(),
            manifest: HashMap::new(),
        }))
    }

    async fn get_plugin_capabilities(
        &self,
        _request: Request<csi::GetPluginCapabilitiesRequest>,
    ) -> Result<Response<csi::GetPluginCapabilitiesResponse>, Status> {
        Ok(Response::new(csi::GetPluginCapabilitiesResponse { capabilities: vec![] }))
    }

    async fn probe(
        &self,
        _request: Request<csi::ProbeRequest>,
    ) -> Result<Response<csi::ProbeResponse>, Status> {
        Ok(Response::new(csi::ProbeResponse { ready: None }))
    }
}

#[tonic::async_trait]
impl csi::controller_server::Controller for ControllerServiceImpl {
    async fn create_volume(
        &self,
        request: Request<csi::CreateVolumeRequest>,
    ) -> Result<Response<csi::CreateVolumeResponse>, Status> {
        let request = request.into_inner();
        if request.name.is_empty() {
            return Err(Status::invalid_argument("CreateVolume.name is required"));
        }

        let capacity_bytes = request
            .capacity_range
            .as_ref()
            .map(|range| range.required_bytes.max(range.limit_bytes))
            .unwrap_or(0);

        Ok(Response::new(csi::CreateVolumeResponse {
            volume: Some(csi::Volume {
                capacity_bytes,
                volume_id: request.name,
                volume_context: HashMap::new(),
                accessible_topology: vec![],
            }),
        }))
    }

    async fn delete_volume(
        &self,
        _request: Request<csi::DeleteVolumeRequest>,
    ) -> Result<Response<csi::DeleteVolumeResponse>, Status> {
        Ok(Response::new(csi::DeleteVolumeResponse {}))
    }

    async fn controller_get_capabilities(
        &self,
        _request: Request<csi::ControllerGetCapabilitiesRequest>,
    ) -> Result<Response<csi::ControllerGetCapabilitiesResponse>, Status> {
        Ok(Response::new(csi::ControllerGetCapabilitiesResponse {
            capabilities: vec![csi::ControllerServiceCapability {
                r#type: Some(csi::controller_service_capability::Type::Rpc(
                    csi::controller_service_capability::Rpc {
                        r#type:
                            csi::controller_service_capability::rpc::Type::CreateDeleteVolume
                                as i32,
                    },
                )),
            }],
        }))
    }
}

#[tonic::async_trait]
impl csi::node_server::Node for NodeServiceImpl {
    async fn node_publish_volume(
        &self,
        request: Request<csi::NodePublishVolumeRequest>,
    ) -> Result<Response<csi::NodePublishVolumeResponse>, Status> {
        let request = request.into_inner();
        let target_path = PathBuf::from(request.target_path.clone());
        if request.target_path.is_empty() {
            return Err(Status::invalid_argument("target_path is required"));
        }

        if is_path_mounted(&target_path) {
            self.mounted_targets
                .lock()
                .await
                .insert(request.target_path.clone(), request.volume_id.clone());
            return Ok(Response::new(csi::NodePublishVolumeResponse {}));
        }

        fs::create_dir_all(&target_path).map_err(io_status)?;
        let pod_namespace = volume_context_required(
            &request.volume_context,
            "csi.storage.k8s.io/pod.namespace",
        )?;
        let pod_name =
            volume_context_required(&request.volume_context, "csi.storage.k8s.io/pod.name")?;

        let sandbox = load_sandbox_ref(&pod_namespace, &pod_name)?;
        let provider_env = fetch_provider_environment(&self.gateway_endpoint, &sandbox.sandbox_id)
            .await
            .map_err(Status::failed_precondition)?;
        let database_url = provider_env
            .get("OPENERAL_DATABASE_URL")
            .cloned()
            .or_else(|| provider_env.get("DATABASE_URL").cloned())
            .ok_or_else(|| Status::failed_precondition("DATABASE_URL provider not attached"))?;

        let workspace_key = workspace_key(&database_url, &sandbox.sandbox_name)?;
        let mount_config = prepare_workspace_mount(
            &database_url,
            &workspace_key,
            target_path.display().to_string(),
        )
            .await
            .map_err(|err| Status::internal(err.to_string()))?;

        let pool = create_pool(&database_url, mount_config.statement_timeout_secs)
            .map_err(|err| Status::internal(err.to_string()))?;
        let target_clone = target_path.clone();
        let mount_config_clone = mount_config.clone();
        let runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            if let Err(err) = openeral_core::fs::sandbox::mount_at(
                pool,
                &mount_config_clone,
                runtime,
                &target_clone,
            ) {
                error!(target = %target_clone.display(), error = %err, "sandbox FUSE mount failed");
            }
        });

        wait_for_mount(&target_path)?;
        self.mounted_targets
            .lock()
            .await
            .insert(request.target_path, request.volume_id);
        Ok(Response::new(csi::NodePublishVolumeResponse {}))
    }

    async fn node_unpublish_volume(
        &self,
        request: Request<csi::NodeUnpublishVolumeRequest>,
    ) -> Result<Response<csi::NodeUnpublishVolumeResponse>, Status> {
        let request = request.into_inner();
        let target_path = PathBuf::from(&request.target_path);
        if target_path.as_os_str().is_empty() {
            return Err(Status::invalid_argument("target_path is required"));
        }

        if is_path_mounted(&target_path) {
            unmount_path(&target_path).map_err(io_status)?;
        }
        self.mounted_targets.lock().await.remove(&request.target_path);
        Ok(Response::new(csi::NodeUnpublishVolumeResponse {}))
    }

    async fn node_get_capabilities(
        &self,
        _request: Request<csi::NodeGetCapabilitiesRequest>,
    ) -> Result<Response<csi::NodeGetCapabilitiesResponse>, Status> {
        Ok(Response::new(csi::NodeGetCapabilitiesResponse {
            capabilities: vec![],
        }))
    }

    async fn node_get_info(
        &self,
        _request: Request<csi::NodeGetInfoRequest>,
    ) -> Result<Response<csi::NodeGetInfoResponse>, Status> {
        Ok(Response::new(csi::NodeGetInfoResponse {
            node_id: self.node_id.clone(),
            max_volumes_per_node: 0,
            accessible_topology: None,
        }))
    }
}

#[derive(Debug)]
struct SandboxRef {
    sandbox_id: String,
    sandbox_name: String,
}

fn load_sandbox_ref(namespace: &str, pod_name: &str) -> Result<SandboxRef, Status> {
    let output = Command::new("kubectl")
        .args(["-n", namespace, "get", "pod", pod_name, "-o", "json"])
        .output()
        .map_err(io_status)?;
    if !output.status.success() {
        return Err(Status::failed_precondition(format!(
            "failed to query pod {namespace}/{pod_name}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    let pod: Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| Status::internal(format!("invalid pod JSON: {err}")))?;
    let containers = pod["spec"]["containers"]
        .as_array()
        .ok_or_else(|| Status::internal("pod.spec.containers missing"))?;
    let container = containers
        .iter()
        .find(|container| container["name"].as_str() == Some("agent"))
        .or_else(|| containers.first())
        .ok_or_else(|| Status::internal("pod has no containers"))?;

    let envs = container["env"]
        .as_array()
        .ok_or_else(|| Status::internal("agent container env missing"))?;
    let sandbox_id = env_value(envs, "OPENSHELL_SANDBOX_ID")
        .ok_or_else(|| Status::failed_precondition("OPENSHELL_SANDBOX_ID missing from pod env"))?;
    let sandbox_name = env_value(envs, "OPENSHELL_SANDBOX")
        .ok_or_else(|| Status::failed_precondition("OPENSHELL_SANDBOX missing from pod env"))?;

    Ok(SandboxRef {
        sandbox_id,
        sandbox_name,
    })
}

fn env_value(envs: &[Value], key: &str) -> Option<String> {
    envs.iter().find_map(|entry| {
        if entry["name"].as_str() == Some(key) {
            entry["value"].as_str().map(ToString::to_string)
        } else {
            None
        }
    })
}

async fn prepare_workspace_mount(
    database_url: &str,
    workspace_key: &str,
    mount_point: String,
) -> Result<WorkspaceMountConfig, Box<dyn std::error::Error + Send + Sync>> {
    let pool = create_pool(database_url, 30)?;
    migrate::run_migrations(&pool).await?;

    let workspace = match ws_queries::get_workspace(&pool, workspace_key).await {
        Ok(workspace) => workspace,
        Err(_) => {
            let layout = WorkspaceLayout::default();
            ws_queries::create_workspace(&pool, workspace_key, Some(workspace_key), &layout).await?;
            ws_queries::seed_from_config(&pool, workspace_key, &layout).await?;
            ws_queries::get_workspace(&pool, workspace_key).await?
        }
    };
    ws_queries::seed_from_config(&pool, workspace_key, &workspace.config).await?;
    ws_queries::normalize_workspace_owner(
        &pool,
        workspace_key,
        DEFAULT_SANDBOX_UID,
        DEFAULT_SANDBOX_GID,
    )
    .await?;

    Ok(WorkspaceMountConfig {
        connection_string: database_url.to_string(),
        workspace_id: workspace_key.to_string(),
        mount_point,
        display_name: workspace.display_name,
        statement_timeout_secs: 30,
    })
}

fn workspace_key(database_url: &str, sandbox_name: &str) -> Result<String, Status> {
    let normalized = normalize_database_identity(database_url)
        .map_err(|err| Status::invalid_argument(format!("invalid DATABASE_URL: {err}")))?;
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let digest_hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{digest_hex}:{sandbox_name}"))
}

fn normalize_database_identity(raw: &str) -> Result<String, tokio_postgres::Error> {
    let config = tokio_postgres::Config::from_str(raw)?;

    let hosts = config
        .get_hosts()
        .iter()
        .map(|host| match host {
            tokio_postgres::config::Host::Tcp(host) => host.to_ascii_lowercase(),
            #[cfg(unix)]
            tokio_postgres::config::Host::Unix(path) => path.display().to_string(),
        })
        .collect::<Vec<_>>()
        .join(",");

    let hostaddrs = config
        .get_hostaddrs()
        .iter()
        .map(IpAddr::to_string)
        .collect::<Vec<_>>()
        .join(",");

    let mut ports = config.get_ports().to_vec();
    if ports.is_empty() {
        ports.push(5432);
    }
    let ports = ports
        .into_iter()
        .map(|port| port.to_string())
        .collect::<Vec<_>>()
        .join(",");

    Ok(format!(
        "user={};dbname={};hosts={};hostaddrs={};ports={};options={};sslmode={:?}",
        config.get_user().unwrap_or(""),
        config.get_dbname().unwrap_or(""),
        hosts,
        hostaddrs,
        ports,
        config.get_options().unwrap_or(""),
        config.get_ssl_mode()
    ))
}

fn volume_context_required(
    volume_context: &HashMap<String, String>,
    key: &str,
) -> Result<String, Status> {
    volume_context
        .get(key)
        .cloned()
        .ok_or_else(|| Status::invalid_argument(format!("volume_context missing {key}")))
}

fn is_path_mounted(path: &Path) -> bool {
    let Ok(mountinfo) = fs::read_to_string("/proc/self/mountinfo") else {
        return false;
    };
    mountinfo.lines().any(|line| {
        line.split(' ')
            .nth(4)
            .is_some_and(|mount_point| mount_point == path.display().to_string())
    })
}

fn wait_for_mount(path: &Path) -> Result<(), Status> {
    for _ in 0..100 {
        if is_path_mounted(path) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(Status::deadline_exceeded(format!(
        "mount did not become visible at {}",
        path.display()
    )))
}

fn unmount_path(path: &Path) -> std::io::Result<()> {
    let status = Command::new("fusermount3")
        .args(["-u", &path.display().to_string()])
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => {
            let status = Command::new("umount").arg(path).status()?;
            if status.success() {
                Ok(())
            } else {
                Err(std::io::Error::other(format!(
                    "failed to unmount {}",
                    path.display()
                )))
            }
        }
    }
}

fn io_status(err: std::io::Error) -> Status {
    Status::internal(err.to_string())
}

type AuthenticatedClient = openshell::open_shell_client::OpenShellClient<
    InterceptedService<Channel, SandboxSecretInterceptor>,
>;

#[derive(Clone)]
struct SandboxSecretInterceptor {
    secret: Option<MetadataValue<tonic::metadata::Ascii>>,
}

impl tonic::service::Interceptor for SandboxSecretInterceptor {
    fn call(
        &mut self,
        mut req: tonic::Request<()>,
    ) -> Result<tonic::Request<()>, tonic::Status> {
        if let Some(ref secret) = self.secret {
            req.metadata_mut().insert("x-sandbox-secret", secret.clone());
        }
        Ok(req)
    }
}

async fn fetch_provider_environment(
    endpoint: &str,
    sandbox_id: &str,
) -> Result<HashMap<String, String>, String> {
    let mut client = connect_gateway(endpoint).await?;
    let response = client
        .get_sandbox_provider_environment(openshell::GetSandboxProviderEnvironmentRequest {
            sandbox_id: sandbox_id.to_string(),
        })
        .await
        .map_err(|err| err.to_string())?;
    Ok(response.into_inner().environment)
}

async fn connect_gateway(endpoint: &str) -> Result<AuthenticatedClient, String> {
    let mut ep = Endpoint::from_shared(endpoint.to_string())
        .map_err(|err| err.to_string())?
        .connect_timeout(std::time::Duration::from_secs(10))
        .http2_keep_alive_interval(std::time::Duration::from_secs(10))
        .keep_alive_while_idle(true)
        .keep_alive_timeout(std::time::Duration::from_secs(20))
        .http2_adaptive_window(true);

    if endpoint.starts_with("https://") {
        let ca_path = std::env::var("OPENSHELL_TLS_CA")
            .map_err(|_| "OPENSHELL_TLS_CA is required".to_string())?;
        let cert_path = std::env::var("OPENSHELL_TLS_CERT")
            .map_err(|_| "OPENSHELL_TLS_CERT is required".to_string())?;
        let key_path = std::env::var("OPENSHELL_TLS_KEY")
            .map_err(|_| "OPENSHELL_TLS_KEY is required".to_string())?;

        let ca_pem = std::fs::read(&ca_path)
            .map_err(|err| format!("failed to read CA cert from {ca_path}: {err}"))?;
        let cert_pem = std::fs::read(&cert_path)
            .map_err(|err| format!("failed to read client cert from {cert_path}: {err}"))?;
        let key_pem = std::fs::read(&key_path)
            .map_err(|err| format!("failed to read client key from {key_path}: {err}"))?;

        ep = ep
            .tls_config(
                ClientTlsConfig::new()
                    .ca_certificate(Certificate::from_pem(ca_pem))
                    .identity(Identity::from_pem(cert_pem, key_pem)),
            )
            .map_err(|err| err.to_string())?;
    }

    let channel = ep.connect().await.map_err(|err| err.to_string())?;
    let secret = std::env::var("OPENSHELL_SSH_HANDSHAKE_SECRET")
        .ok()
        .and_then(|value| value.parse().ok());
    Ok(openshell::open_shell_client::OpenShellClient::with_interceptor(
        channel,
        SandboxSecretInterceptor { secret },
    ))
}
