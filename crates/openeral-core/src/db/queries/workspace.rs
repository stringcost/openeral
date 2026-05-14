use crate::db::queries::get_client;
use crate::db::types::{WorkspaceConfig, WorkspaceFile, WorkspaceLayout};
use crate::error::FsError;
use std::ffi::CString;

fn default_workspace_owner() -> (i32, i32) {
    lookup_user_owner("sandbox")
        .unwrap_or_else(|| unsafe { (libc::getuid() as i32, libc::getgid() as i32) })
}

fn lookup_user_owner(user: &str) -> Option<(i32, i32)> {
    let user = CString::new(user).ok()?;
    let passwd = unsafe { libc::getpwnam(user.as_ptr()) };
    if passwd.is_null() {
        return None;
    }

    let passwd = unsafe { *passwd };
    Some((passwd.pw_uid as i32, passwd.pw_gid as i32))
}

/// Create a new workspace configuration.
pub async fn create_workspace(
    pool: &deadpool_postgres::Pool,
    id: &str,
    display_name: Option<&str>,
    config: &WorkspaceLayout,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;
    let config_json =
        serde_json::to_value(config).map_err(|e| FsError::SerializationError(e.to_string()))?;

    client
        .execute(
            "INSERT INTO _openeral.workspace_config (id, display_name, config) VALUES ($1, $2, $3)",
            &[&id, &display_name, &config_json],
        )
        .await?;
    Ok(())
}

/// Get a workspace configuration by ID.
pub async fn get_workspace(
    pool: &deadpool_postgres::Pool,
    id: &str,
) -> Result<WorkspaceConfig, FsError> {
    let client = get_client(pool).await?;
    let row = client
        .query_opt(
            "SELECT id, display_name, config, created_at, updated_at FROM _openeral.workspace_config WHERE id = $1",
            &[&id],
        )
        .await?
        .ok_or(FsError::NotFound)?;

    let config_json: serde_json::Value = row.get("config");
    let layout: WorkspaceLayout = serde_json::from_value(config_json)
        .map_err(|e| FsError::SerializationError(e.to_string()))?;

    Ok(WorkspaceConfig {
        id: row.get("id"),
        display_name: row.get("display_name"),
        config: layout,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

/// List all workspace configurations.
pub async fn list_workspaces(
    pool: &deadpool_postgres::Pool,
) -> Result<Vec<WorkspaceConfig>, FsError> {
    let client = get_client(pool).await?;
    let rows = client
        .query(
            "SELECT id, display_name, config, created_at, updated_at FROM _openeral.workspace_config ORDER BY id",
            &[],
        )
        .await?;

    let mut workspaces = Vec::with_capacity(rows.len());
    for row in rows {
        let config_json: serde_json::Value = row.get("config");
        let layout: WorkspaceLayout = serde_json::from_value(config_json)
            .map_err(|e| FsError::SerializationError(e.to_string()))?;
        workspaces.push(WorkspaceConfig {
            id: row.get("id"),
            display_name: row.get("display_name"),
            config: layout,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        });
    }
    Ok(workspaces)
}

/// Delete a workspace and all its files (CASCADE).
pub async fn delete_workspace(pool: &deadpool_postgres::Pool, id: &str) -> Result<(), FsError> {
    let client = get_client(pool).await?;
    let count = client
        .execute(
            "DELETE FROM _openeral.workspace_config WHERE id = $1",
            &[&id],
        )
        .await?;

    if count == 0 {
        return Err(FsError::NotFound);
    }
    Ok(())
}

/// Get a file or directory by path within a workspace.
pub async fn get_file(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    path: &str,
) -> Result<WorkspaceFile, FsError> {
    let client = get_client(pool).await?;
    get_file_with_client(&client, workspace_id, path).await
}

async fn get_file_with_client(
    client: &tokio_postgres::Client,
    workspace_id: &str,
    path: &str,
) -> Result<WorkspaceFile, FsError> {
    let row = client
        .query_opt(
            "SELECT workspace_id, path, parent_path, name, is_dir, content, mode, size, \
             mtime_ns, ctime_ns, atime_ns, nlink, uid, gid \
             FROM _openeral.workspace_files \
             WHERE workspace_id = $1 AND path = $2",
            &[&workspace_id, &path],
        )
        .await?
        .ok_or(FsError::NotFound)?;

    Ok(row_to_workspace_file(&row))
}

/// List children of a directory.
pub async fn list_children(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    parent_path: &str,
) -> Result<Vec<WorkspaceFile>, FsError> {
    let client = get_client(pool).await?;
    let rows = client
        .query(
            "SELECT workspace_id, path, parent_path, name, is_dir, content, mode, size, \
             mtime_ns, ctime_ns, atime_ns, nlink, uid, gid \
             FROM _openeral.workspace_files \
             WHERE workspace_id = $1 AND parent_path = $2 \
             ORDER BY name",
            &[&workspace_id, &parent_path],
        )
        .await?;

    Ok(rows.iter().map(row_to_workspace_file).collect())
}

/// Normalize the recorded uid/gid for every persisted row in a workspace.
///
/// This is used when the mounting environment differs from the sandbox
/// runtime image. The k3s-side CSI node plugin runs as root and may not have
/// the sandbox user in `/etc/passwd`, but the workload itself expects the
/// workspace tree to belong to the sandbox uid/gid.
pub async fn normalize_workspace_owner(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    uid: i32,
    gid: i32,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;
    client
        .execute(
            "UPDATE _openeral.workspace_files \
             SET uid = $2, gid = $3 \
             WHERE workspace_id = $1 AND (uid <> $2 OR gid <> $3)",
            &[&workspace_id, &uid, &gid],
        )
        .await?;
    Ok(())
}

/// Create a new file or directory.
pub async fn create_file(
    pool: &deadpool_postgres::Pool,
    file: &WorkspaceFile,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;

    // Check if already exists
    let exists = client
        .query_opt(
            "SELECT 1 FROM _openeral.workspace_files WHERE workspace_id = $1 AND path = $2",
            &[&file.workspace_id, &file.path],
        )
        .await?;

    if exists.is_some() {
        return Err(FsError::FileExists);
    }

    client
        .execute(
            "INSERT INTO _openeral.workspace_files \
             (workspace_id, path, parent_path, name, is_dir, content, mode, size, \
              mtime_ns, ctime_ns, atime_ns, nlink, uid, gid) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
            &[
                &file.workspace_id,
                &file.path,
                &file.parent_path,
                &file.name,
                &file.is_dir,
                &file.content,
                &file.mode,
                &file.size,
                &file.mtime_ns,
                &file.ctime_ns,
                &file.atime_ns,
                &file.nlink,
                &file.uid,
                &file.gid,
            ],
        )
        .await?;
    Ok(())
}

/// Update file content and size (used by flush/release).
pub async fn update_file_content(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    path: &str,
    content: &[u8],
    mtime_ns: i64,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;
    let size = content.len() as i64;
    client
        .execute(
            "UPDATE _openeral.workspace_files \
             SET content = $3, size = $4, mtime_ns = $5 \
             WHERE workspace_id = $1 AND path = $2",
            &[&workspace_id, &path, &content, &size, &mtime_ns],
        )
        .await?;
    Ok(())
}

/// Update file metadata (mode, size for truncate, mtime).
pub async fn update_file_attrs(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    path: &str,
    mode: Option<i32>,
    size: Option<i64>,
    mtime_ns: Option<i64>,
    atime_ns: Option<i64>,
) -> Result<WorkspaceFile, FsError> {
    let client = get_client(pool).await?;

    // Build dynamic SET clauses
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64;

    if let Some(m) = mode {
        client
            .execute(
                "UPDATE _openeral.workspace_files SET mode = $3, ctime_ns = $4 \
                 WHERE workspace_id = $1 AND path = $2",
                &[&workspace_id, &path, &m, &now_ns],
            )
            .await?;
    }

    if let Some(s) = size {
        let truncate_len = i32::try_from(s).map_err(|_| {
            FsError::InvalidArgument(format!(
                "truncate size {s} exceeds PostgreSQL substring integer limit"
            ))
        })?;
        // Truncation: if new size < current size, trim content
        client
            .execute(
                "UPDATE _openeral.workspace_files \
                 SET size = $3, \
                     content = CASE WHEN $4 = 0 THEN '\\x'::bytea \
                               ELSE substring(COALESCE(content, '\\x'::bytea) FROM 1 FOR $4) END, \
                     mtime_ns = $5, ctime_ns = $5 \
                 WHERE workspace_id = $1 AND path = $2",
                &[&workspace_id, &path, &s, &truncate_len, &now_ns],
            )
            .await?;
    }

    if let Some(mt) = mtime_ns {
        client
            .execute(
                "UPDATE _openeral.workspace_files SET mtime_ns = $3 \
                 WHERE workspace_id = $1 AND path = $2",
                &[&workspace_id, &path, &mt],
            )
            .await?;
    }

    if let Some(at) = atime_ns {
        client
            .execute(
                "UPDATE _openeral.workspace_files SET atime_ns = $3 \
                 WHERE workspace_id = $1 AND path = $2",
                &[&workspace_id, &path, &at],
            )
            .await?;
    }

    get_file_with_client(&client, workspace_id, path).await
}

/// Delete a file.
pub async fn delete_file(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    path: &str,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;
    let count = client
        .execute(
            "DELETE FROM _openeral.workspace_files WHERE workspace_id = $1 AND path = $2 AND is_dir = false",
            &[&workspace_id, &path],
        )
        .await?;

    if count == 0 {
        return Err(FsError::NotFound);
    }
    Ok(())
}

/// Delete an empty directory.
pub async fn delete_directory(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    path: &str,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;

    // Check if directory has children
    let has_children = client
        .query_opt(
            "SELECT 1 FROM _openeral.workspace_files \
             WHERE workspace_id = $1 AND parent_path = $2 LIMIT 1",
            &[&workspace_id, &path],
        )
        .await?;

    if has_children.is_some() {
        return Err(FsError::DirectoryNotEmpty);
    }

    let count = client
        .execute(
            "DELETE FROM _openeral.workspace_files WHERE workspace_id = $1 AND path = $2 AND is_dir = true",
            &[&workspace_id, &path],
        )
        .await?;

    if count == 0 {
        return Err(FsError::NotFound);
    }
    Ok(())
}

/// Rename a single file or directory.
pub async fn rename_file(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    old_path: &str,
    new_path: &str,
    new_parent_path: &str,
    new_name: &str,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64;

    // Delete any existing file at new_path
    client
        .execute(
            "DELETE FROM _openeral.workspace_files WHERE workspace_id = $1 AND path = $2",
            &[&workspace_id, &new_path],
        )
        .await?;

    // Rename the file itself
    client
        .execute(
            "UPDATE _openeral.workspace_files \
             SET path = $3, parent_path = $4, name = $5, ctime_ns = $6 \
             WHERE workspace_id = $1 AND path = $2",
            &[
                &workspace_id,
                &old_path,
                &new_path,
                &new_parent_path,
                &new_name,
                &now_ns,
            ],
        )
        .await?;

    Ok(())
}

/// Rename a directory tree (update all paths with the old prefix).
pub async fn rename_tree(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<(), FsError> {
    let client = get_client(pool).await?;
    let old_like = format!("{}/%", old_prefix);

    // Update all descendants: replace old prefix with new prefix in path and parent_path
    client
        .execute(
            "UPDATE _openeral.workspace_files \
             SET path = $4 || substring(path FROM length($3) + 1), \
                 parent_path = $4 || substring(parent_path FROM length($3) + 1) \
             WHERE workspace_id = $1 AND path LIKE $2",
            &[&workspace_id, &old_like, &old_prefix, &new_prefix],
        )
        .await?;

    Ok(())
}

/// Seed a workspace from its config (create auto_dirs and seed_files).
/// Ensures the root directory exists.
pub async fn seed_from_config(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    layout: &WorkspaceLayout,
) -> Result<(), FsError> {
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64;
    let (uid, gid) = default_workspace_owner();

    // Ensure root directory exists
    let root = WorkspaceFile {
        workspace_id: workspace_id.to_string(),
        path: "/".to_string(),
        parent_path: "".to_string(),
        name: "".to_string(),
        is_dir: true,
        content: None,
        mode: 0o40755,
        size: 0,
        mtime_ns: now_ns,
        ctime_ns: now_ns,
        atime_ns: now_ns,
        nlink: 2,
        uid,
        gid,
    };
    let _ = create_file(pool, &root).await; // Ignore if exists

    // Create auto_dirs
    for dir_path in &layout.auto_dirs {
        let normalized = normalize_path(dir_path);
        let (parent, name) = split_path(&normalized);

        let dir = WorkspaceFile {
            workspace_id: workspace_id.to_string(),
            path: normalized.clone(),
            parent_path: parent,
            name,
            is_dir: true,
            content: None,
            mode: 0o40755,
            size: 0,
            mtime_ns: now_ns,
            ctime_ns: now_ns,
            atime_ns: now_ns,
            nlink: 2,
            uid,
            gid,
        };
        let _ = create_file(pool, &dir).await; // Ignore if already exists
    }

    // Create seed_files
    for (file_path, content_str) in &layout.seed_files {
        let normalized = normalize_path(file_path);
        let (parent, name) = split_path(&normalized);
        let content = content_str.as_bytes().to_vec();

        let file = WorkspaceFile {
            workspace_id: workspace_id.to_string(),
            path: normalized.clone(),
            parent_path: parent,
            name,
            is_dir: false,
            content: Some(content.clone()),
            mode: 0o100644,
            size: content.len() as i64,
            mtime_ns: now_ns,
            ctime_ns: now_ns,
            atime_ns: now_ns,
            nlink: 1,
            uid,
            gid,
        };
        let _ = create_file(pool, &file).await; // Ignore if already exists
    }

    Ok(())
}

/// Seed a workspace from a local directory.
pub async fn seed_from_directory(
    pool: &deadpool_postgres::Pool,
    workspace_id: &str,
    local_dir: &std::path::Path,
) -> Result<u64, FsError> {
    let mut count = 0u64;
    let (uid, gid) = default_workspace_owner();
    seed_dir_recursive(pool, workspace_id, local_dir, "/", uid, gid, &mut count).await?;
    Ok(count)
}

fn seed_dir_recursive<'a>(
    pool: &'a deadpool_postgres::Pool,
    workspace_id: &'a str,
    local_path: &'a std::path::Path,
    db_path: &'a str,
    uid: i32,
    gid: i32,
    count: &'a mut u64,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), FsError>> + Send + 'a>> {
    Box::pin(async move {
        let now_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as i64;

        let mut entries = tokio::fs::read_dir(local_path)
            .await
            .map_err(FsError::IoError)?;

        while let Some(entry) = entries.next_entry().await.map_err(FsError::IoError)? {
            let file_type = entry.file_type().await.map_err(FsError::IoError)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let child_path = if db_path == "/" {
                format!("/{}", name)
            } else {
                format!("{}/{}", db_path, name)
            };

            if file_type.is_dir() {
                let dir = WorkspaceFile {
                    workspace_id: workspace_id.to_string(),
                    path: child_path.clone(),
                    parent_path: db_path.to_string(),
                    name: name.clone(),
                    is_dir: true,
                    content: None,
                    mode: 0o40755,
                    size: 0,
                    mtime_ns: now_ns,
                    ctime_ns: now_ns,
                    atime_ns: now_ns,
                    nlink: 2,
                    uid,
                    gid,
                };
                let _ = create_file(pool, &dir).await;
                *count += 1;
                seed_dir_recursive(
                    pool,
                    workspace_id,
                    &entry.path(),
                    &child_path,
                    uid,
                    gid,
                    count,
                )
                .await?;
            } else if file_type.is_file() {
                let content = tokio::fs::read(entry.path())
                    .await
                    .map_err(FsError::IoError)?;
                let file = WorkspaceFile {
                    workspace_id: workspace_id.to_string(),
                    path: child_path,
                    parent_path: db_path.to_string(),
                    name,
                    is_dir: false,
                    content: Some(content.clone()),
                    mode: 0o100644,
                    size: content.len() as i64,
                    mtime_ns: now_ns,
                    ctime_ns: now_ns,
                    atime_ns: now_ns,
                    nlink: 1,
                    uid,
                    gid,
                };
                let _ = create_file(pool, &file).await;
                *count += 1;
            }
        }
        Ok(())
    })
}

/// Normalize a path: ensure it starts with /, remove trailing slash.
fn normalize_path(path: &str) -> String {
    let p = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{}", path)
    };
    if p.len() > 1 && p.ends_with('/') {
        p[..p.len() - 1].to_string()
    } else {
        p
    }
}

/// Split a path into (parent_path, name).
fn split_path(path: &str) -> (String, String) {
    if path == "/" {
        return ("".to_string(), "".to_string());
    }
    match path.rfind('/') {
        Some(0) => ("/".to_string(), path[1..].to_string()),
        Some(idx) => (path[..idx].to_string(), path[idx + 1..].to_string()),
        None => ("/".to_string(), path.to_string()),
    }
}

fn row_to_workspace_file(row: &tokio_postgres::Row) -> WorkspaceFile {
    WorkspaceFile {
        workspace_id: row.get("workspace_id"),
        path: row.get("path"),
        parent_path: row.get("parent_path"),
        name: row.get("name"),
        is_dir: row.get("is_dir"),
        content: row.get("content"),
        mode: row.get("mode"),
        size: row.get("size"),
        mtime_ns: row.get("mtime_ns"),
        ctime_ns: row.get("ctime_ns"),
        atime_ns: row.get("atime_ns"),
        nlink: row.get("nlink"),
        uid: row.get("uid"),
        gid: row.get("gid"),
    }
}
