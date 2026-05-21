use openeral_core::db::migrate;
use openeral_core::db::pool::create_pool;
use openeral_core::db::queries::workspace as ws_queries;
use openeral_core::db::types::{WorkspaceFile, WorkspaceLayout};
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::sync::OnceCell;

static SETUP_CELL: OnceCell<()> = OnceCell::const_new();
static COUNTER: AtomicU32 = AtomicU32::new(1);

fn connection_string() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "host=postgres user=pgmount password=pgmount dbname=testdb".to_string())
}

/// Ensure migrations run exactly once across all tests.
async fn setup_db(pool: &deadpool_postgres::Pool) {
    SETUP_CELL
        .get_or_init(|| async {
            migrate::run_migrations(pool).await.unwrap();
        })
        .await;
}

async fn get_pool() -> deadpool_postgres::Pool {
    let pool = create_pool(&connection_string(), 30).unwrap();
    setup_db(&pool).await;
    pool
}

/// Generate a unique workspace ID for each test to avoid races.
fn unique_ws_id(prefix: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}-{}", prefix, std::process::id(), now_ns(), n)
}

fn now_ns() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64
}

fn test_file(ws_id: &str, path: &str, parent: &str, name: &str, content: &[u8]) -> WorkspaceFile {
    let now = now_ns();
    WorkspaceFile {
        workspace_id: ws_id.to_string(),
        path: path.to_string(),
        parent_path: parent.to_string(),
        name: name.to_string(),
        is_dir: false,
        content: Some(content.to_vec()),
        mode: 0o100644,
        size: content.len() as i64,
        mtime_ns: now,
        ctime_ns: now,
        atime_ns: now,
        nlink: 1,
        uid: 1000,
        gid: 1000,
    }
}

fn test_dir(ws_id: &str, path: &str, parent: &str, name: &str) -> WorkspaceFile {
    let now = now_ns();
    WorkspaceFile {
        workspace_id: ws_id.to_string(),
        path: path.to_string(),
        parent_path: parent.to_string(),
        name: name.to_string(),
        is_dir: true,
        content: None,
        mode: 0o40755,
        size: 0,
        mtime_ns: now,
        ctime_ns: now,
        atime_ns: now,
        nlink: 2,
        uid: 1000,
        gid: 1000,
    }
}

#[tokio::test]
async fn test_create_and_get_workspace() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-create");

    let layout = WorkspaceLayout {
        auto_dirs: vec![".claude".into(), ".claude/memory".into()],
        seed_files: Default::default(),
    };

    ws_queries::create_workspace(&pool, &ws_id, Some("Test Workspace"), &layout)
        .await
        .unwrap();

    let ws = ws_queries::get_workspace(&pool, &ws_id).await.unwrap();
    assert_eq!(ws.id, ws_id);
    assert_eq!(ws.display_name, Some("Test Workspace".to_string()));
    assert_eq!(ws.config.auto_dirs.len(), 2);

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_list_workspaces() {
    let pool = get_pool().await;
    let ws1 = unique_ws_id("ws-list");
    let ws2 = unique_ws_id("ws-list");

    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws1, Some("One"), &layout)
        .await
        .unwrap();
    ws_queries::create_workspace(&pool, &ws2, Some("Two"), &layout)
        .await
        .unwrap();

    let workspaces = ws_queries::list_workspaces(&pool).await.unwrap();
    assert!(workspaces.iter().any(|w| w.id == ws1));
    assert!(workspaces.iter().any(|w| w.id == ws2));

    ws_queries::delete_workspace(&pool, &ws1).await.unwrap();
    ws_queries::delete_workspace(&pool, &ws2).await.unwrap();
}

#[tokio::test]
async fn test_create_and_get_file() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-file");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let file = test_file(&ws_id, "/hello.txt", "/", "hello.txt", b"hello world");
    ws_queries::create_file(&pool, &file).await.unwrap();

    let fetched = ws_queries::get_file(&pool, &ws_id, "/hello.txt")
        .await
        .unwrap();
    assert_eq!(fetched.name, "hello.txt");
    assert_eq!(fetched.content, Some(b"hello world".to_vec()));
    assert_eq!(fetched.size, 11);
    assert!(!fetched.is_dir);

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_create_file_exists_error() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-exists");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let file = test_file(&ws_id, "/dup.txt", "/", "dup.txt", b"first");
    ws_queries::create_file(&pool, &file).await.unwrap();
    let err = ws_queries::create_file(&pool, &file).await.unwrap_err();
    assert!(matches!(err, openeral_core::error::FsError::FileExists));

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_list_children() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-children");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let dir = test_dir(&ws_id, "/mydir", "/", "mydir");
    ws_queries::create_file(&pool, &dir).await.unwrap();

    for name in ["a.txt", "b.txt", "c.txt"] {
        let f = test_file(
            &ws_id,
            &format!("/mydir/{}", name),
            "/mydir",
            name,
            name.as_bytes(),
        );
        ws_queries::create_file(&pool, &f).await.unwrap();
    }

    let children = ws_queries::list_children(&pool, &ws_id, "/mydir")
        .await
        .unwrap();
    assert_eq!(children.len(), 3);
    let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["a.txt", "b.txt", "c.txt"]);

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_metadata_queries_omit_content() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-meta");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let dir = test_dir(&ws_id, "/meta", "/", "meta");
    ws_queries::create_file(&pool, &dir).await.unwrap();

    let file = test_file(
        &ws_id,
        "/meta/blob.txt",
        "/meta",
        "blob.txt",
        b"metadata-should-not-fetch-content",
    );
    ws_queries::create_file(&pool, &file).await.unwrap();

    let metadata = ws_queries::get_file_metadata(&pool, &ws_id, "/meta/blob.txt")
        .await
        .unwrap();
    assert_eq!(metadata.name, "blob.txt");
    assert_eq!(metadata.size, file.size);
    assert_eq!(metadata.content, None);

    let children = ws_queries::list_children_metadata(&pool, &ws_id, "/meta")
        .await
        .unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "blob.txt");
    assert_eq!(children[0].size, file.size);
    assert_eq!(children[0].content, None);

    let full = ws_queries::get_file(&pool, &ws_id, "/meta/blob.txt")
        .await
        .unwrap();
    assert_eq!(
        full.content,
        Some(b"metadata-should-not-fetch-content".to_vec())
    );

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_update_file_content() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-update");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let file = test_file(&ws_id, "/data.bin", "/", "data.bin", b"initial");
    ws_queries::create_file(&pool, &file).await.unwrap();

    let now = now_ns();
    ws_queries::update_file_content(&pool, &ws_id, "/data.bin", b"updated content", now)
        .await
        .unwrap();

    let fetched = ws_queries::get_file(&pool, &ws_id, "/data.bin")
        .await
        .unwrap();
    assert_eq!(fetched.content, Some(b"updated content".to_vec()));
    assert_eq!(fetched.size, 15);

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_update_file_content_replaces_longer_content_without_tail() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-update-shorter");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let longer =
        br#"{"openeralSmoke":{"runId":"initial"},"padding":"this content must disappear"}"#;
    let shorter = br#"{"openeralSmoke":{"runId":"short"}}"#;
    let file = test_file(&ws_id, "/.claude/.claude.json", "/", ".claude.json", longer);
    ws_queries::create_file(&pool, &file).await.unwrap();

    ws_queries::update_file_content(&pool, &ws_id, "/.claude/.claude.json", shorter, now_ns())
        .await
        .unwrap();

    let fetched = ws_queries::get_file(&pool, &ws_id, "/.claude/.claude.json")
        .await
        .unwrap();
    assert_eq!(fetched.size, shorter.len() as i64);
    assert_eq!(fetched.content.as_deref(), Some(shorter.as_slice()));
    serde_json::from_slice::<serde_json::Value>(fetched.content.as_ref().unwrap()).unwrap();

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_update_file_attrs_truncate_and_overwrite_sequence() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-truncate");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let file = test_file(&ws_id, "/truncate.txt", "/", "truncate.txt", b"persist-ok");
    ws_queries::create_file(&pool, &file).await.unwrap();

    let truncated =
        ws_queries::update_file_attrs(&pool, &ws_id, "/truncate.txt", None, Some(0), None, None)
            .await
            .unwrap();
    assert_eq!(truncated.size, 0);
    assert_eq!(truncated.content, Some(Vec::new()));

    ws_queries::update_file_content(&pool, &ws_id, "/truncate.txt", b"overwrite-ok", now_ns())
        .await
        .unwrap();

    let overwritten = ws_queries::get_file(&pool, &ws_id, "/truncate.txt")
        .await
        .unwrap();
    assert_eq!(overwritten.size, 12);
    assert_eq!(overwritten.content, Some(b"overwrite-ok".to_vec()));

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_delete_file() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-delfile");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let file = test_file(&ws_id, "/todelete.txt", "/", "todelete.txt", b"bye");
    ws_queries::create_file(&pool, &file).await.unwrap();
    ws_queries::delete_file(&pool, &ws_id, "/todelete.txt")
        .await
        .unwrap();

    let err = ws_queries::get_file(&pool, &ws_id, "/todelete.txt")
        .await
        .unwrap_err();
    assert!(matches!(err, openeral_core::error::FsError::NotFound));

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_delete_nonempty_dir() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-notempty");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let dir = test_dir(&ws_id, "/notempty", "/", "notempty");
    ws_queries::create_file(&pool, &dir).await.unwrap();

    let file = test_file(
        &ws_id,
        "/notempty/child.txt",
        "/notempty",
        "child.txt",
        b"x",
    );
    ws_queries::create_file(&pool, &file).await.unwrap();

    let err = ws_queries::delete_directory(&pool, &ws_id, "/notempty")
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        openeral_core::error::FsError::DirectoryNotEmpty
    ));

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_rename_file() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-rename");
    let layout = WorkspaceLayout::default();
    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let file = test_file(&ws_id, "/old.txt", "/", "old.txt", b"rename me");
    ws_queries::create_file(&pool, &file).await.unwrap();

    ws_queries::rename_file(&pool, &ws_id, "/old.txt", "/new.txt", "/", "new.txt")
        .await
        .unwrap();

    let err = ws_queries::get_file(&pool, &ws_id, "/old.txt")
        .await
        .unwrap_err();
    assert!(matches!(err, openeral_core::error::FsError::NotFound));

    let renamed = ws_queries::get_file(&pool, &ws_id, "/new.txt")
        .await
        .unwrap();
    assert_eq!(renamed.name, "new.txt");
    assert_eq!(renamed.content, Some(b"rename me".to_vec()));

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_seed_from_config() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-seed");

    let layout = WorkspaceLayout {
        auto_dirs: vec![".claude".into(), ".claude/memory".into()],
        seed_files: [(
            ".claude/settings.json".into(),
            "{\"model\": \"sonnet\"}".into(),
        )]
        .into(),
    };

    ws_queries::create_workspace(&pool, &ws_id, Some("Seed Test"), &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let root = ws_queries::get_file(&pool, &ws_id, "/").await.unwrap();
    assert!(root.is_dir);

    let claude_dir = ws_queries::get_file(&pool, &ws_id, "/.claude")
        .await
        .unwrap();
    assert!(claude_dir.is_dir);

    let memory_dir = ws_queries::get_file(&pool, &ws_id, "/.claude/memory")
        .await
        .unwrap();
    assert!(memory_dir.is_dir);

    let settings = ws_queries::get_file(&pool, &ws_id, "/.claude/settings.json")
        .await
        .unwrap();
    assert!(!settings.is_dir);
    assert_eq!(settings.content, Some(b"{\"model\": \"sonnet\"}".to_vec()));

    let children = ws_queries::list_children(&pool, &ws_id, "/").await.unwrap();
    assert!(children.iter().any(|c| c.name == ".claude"));

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
}

#[tokio::test]
async fn test_seed_from_directory_uses_default_workspace_owner() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-seed-dir");
    let layout = WorkspaceLayout::default();
    let temp_dir = std::env::temp_dir().join(format!("openeral-seed-{}", ws_id));

    std::fs::create_dir_all(temp_dir.join("nested")).unwrap();
    std::fs::write(
        temp_dir.join("nested").join("hello.txt"),
        b"hello from disk",
    )
    .unwrap();

    ws_queries::create_workspace(&pool, &ws_id, Some("Seed Dir Test"), &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    let root = ws_queries::get_file(&pool, &ws_id, "/").await.unwrap();
    let count = ws_queries::seed_from_directory(&pool, &ws_id, &temp_dir)
        .await
        .unwrap();
    assert_eq!(count, 2);

    let nested = ws_queries::get_file(&pool, &ws_id, "/nested")
        .await
        .unwrap();
    assert!(nested.is_dir);
    assert_eq!(nested.uid, root.uid);
    assert_eq!(nested.gid, root.gid);

    let hello = ws_queries::get_file(&pool, &ws_id, "/nested/hello.txt")
        .await
        .unwrap();
    assert!(!hello.is_dir);
    assert_eq!(hello.content, Some(b"hello from disk".to_vec()));
    assert_eq!(hello.uid, root.uid);
    assert_eq!(hello.gid, root.gid);

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();
    std::fs::remove_dir_all(&temp_dir).unwrap();
}

#[tokio::test]
async fn test_cascade_delete() {
    let pool = get_pool().await;
    let ws_id = unique_ws_id("ws-cascade");
    let layout = WorkspaceLayout {
        auto_dirs: vec![".claude".into()],
        seed_files: [(".claude/test.txt".into(), "data".into())].into(),
    };

    ws_queries::create_workspace(&pool, &ws_id, None, &layout)
        .await
        .unwrap();
    ws_queries::seed_from_config(&pool, &ws_id, &layout)
        .await
        .unwrap();

    ws_queries::get_file(&pool, &ws_id, "/.claude/test.txt")
        .await
        .unwrap();

    ws_queries::delete_workspace(&pool, &ws_id).await.unwrap();

    let err = ws_queries::get_file(&pool, &ws_id, "/.claude/test.txt")
        .await
        .unwrap_err();
    assert!(matches!(err, openeral_core::error::FsError::NotFound));
}
