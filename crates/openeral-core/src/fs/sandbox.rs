use std::ffi::OsStr;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use fuser::{
    Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, OpenFlags,
    RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry,
    ReplyOpen, ReplyWrite, Request, TimeOrNow, WriteFlags,
};
use tracing::{debug, warn};

use crate::config::types::{MountConfig, WorkspaceMountConfig};
use crate::db::pool::DbPool;
use crate::db::queries::workspace as ws_queries;
use crate::db::types::WorkspaceFile;
use crate::error::FsError;
use crate::fs::attr::BLOCK_SIZE;
use crate::fs::cache::{MetadataCache, WorkspaceCache};
use crate::fs::inode::{InodeTable, NodeIdentity};
use crate::fs::nodes::{self, NodeContext};
use crate::fs::workspace_inode::WorkspaceInodeTable;

const TTL: Duration = Duration::from_secs(1);
const DB_ROOT: &str = "/.db";

const SENSITIVE_DIR_NAMES: &[&str] = &[
    ".aws", ".azure", ".docker", ".gnupg", ".kube", ".npm", ".ssh",
];
const SENSITIVE_FILE_NAMES: &[&str] = &[
    ".bash_history",
    ".git-credentials",
    ".lesshst",
    ".mysql_history",
    ".netrc",
    ".npmrc",
    ".psql_history",
    ".python_history",
    ".wget-hsts",
    ".zsh_history",
];
const SENSITIVE_PATH_PREFIXES: &[&str] = &["/.local/share/keyrings"];

enum OpenFileKind {
    Workspace { path: String },
    ReadOnly,
}

struct OpenFileHandle {
    kind: OpenFileKind,
    content: Vec<u8>,
    dirty: bool,
}

/// Combined sandbox filesystem:
/// - writable workspace root backed by `_openeral.workspace_files`
/// - hidden read-only database browser rooted at `/.db`
pub struct SandboxFilesystem {
    rt: tokio::runtime::Handle,
    pool: DbPool,
    workspace_id: String,
    inodes: WorkspaceInodeTable,
    db_nodes: DashMap<String, NodeIdentity>,
    db_inode_table: InodeTable,
    db_cache: MetadataCache,
    workspace_cache: WorkspaceCache,
    db_config: MountConfig,
    open_files: DashMap<u64, OpenFileHandle>,
    next_fh: std::sync::atomic::AtomicU64,
}

impl SandboxFilesystem {
    pub fn new(pool: DbPool, config: &WorkspaceMountConfig, rt: tokio::runtime::Handle) -> Self {
        let db_config = MountConfig {
            connection_string: config.connection_string.clone(),
            mount_point: config.mount_point.clone(),
            schemas: None,
            read_only: true,
            cache_ttl: Duration::from_secs(30),
            page_size: 1000,
            statement_timeout_secs: config.statement_timeout_secs,
        };

        let db_nodes = DashMap::new();
        db_nodes.insert(DB_ROOT.to_string(), NodeIdentity::Root);

        Self {
            rt,
            pool,
            workspace_id: config.workspace_id.clone(),
            inodes: WorkspaceInodeTable::new(),
            db_nodes,
            db_inode_table: InodeTable::new(),
            db_cache: MetadataCache::new(db_config.cache_ttl),
            workspace_cache: WorkspaceCache::new(Duration::from_secs(1)),
            db_config,
            open_files: DashMap::new(),
            next_fh: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn alloc_fh(&self) -> u64 {
        self.next_fh
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn now_ns() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as i64
    }

    fn ns_to_system_time(ns: i64) -> SystemTime {
        UNIX_EPOCH + Duration::from_nanos(ns as u64)
    }

    fn file_to_attr(ino: u64, file: &WorkspaceFile) -> FileAttr {
        let kind = if file.is_dir {
            FileType::Directory
        } else {
            FileType::RegularFile
        };
        let size = file.size as u64;
        FileAttr {
            ino: INodeNo(ino),
            size,
            blocks: size.div_ceil(BLOCK_SIZE as u64),
            atime: Self::ns_to_system_time(file.atime_ns),
            mtime: Self::ns_to_system_time(file.mtime_ns),
            ctime: Self::ns_to_system_time(file.ctime_ns),
            crtime: Self::ns_to_system_time(file.ctime_ns),
            kind,
            perm: (file.mode as u16) & 0o7777,
            nlink: file.nlink as u32,
            uid: file.uid as u32,
            gid: file.gid as u32,
            rdev: 0,
            blksize: BLOCK_SIZE,
            flags: 0,
        }
    }

    fn child_path(parent_path: &str, name: &str) -> String {
        if parent_path == "/" {
            format!("/{}", name)
        } else {
            format!("{}/{}", parent_path, name)
        }
    }

    fn is_db_path(path: &str) -> bool {
        path == DB_ROOT || path.starts_with("/.db/")
    }

    fn is_reserved_path(path: &str) -> bool {
        Self::is_db_path(path)
    }

    fn is_sensitive_path(path: &str) -> bool {
        if path == "/" || Self::is_db_path(path) {
            return false;
        }

        if SENSITIVE_PATH_PREFIXES
            .iter()
            .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
        {
            return true;
        }

        let segments: Vec<&str> = path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        if segments
            .iter()
            .any(|segment| SENSITIVE_DIR_NAMES.contains(segment))
        {
            return true;
        }

        segments
            .last()
            .is_some_and(|name| SENSITIVE_FILE_NAMES.contains(name))
    }

    fn db_ctx(&self) -> NodeContext<'_> {
        NodeContext {
            pool: &self.pool,
            cache: &self.db_cache,
            inodes: &self.db_inode_table,
            config: &self.db_config,
        }
    }

    fn db_identity_for_path(&self, path: &str) -> Option<NodeIdentity> {
        self.db_nodes.get(path).map(|entry| entry.clone())
    }

    fn parent_path(path: &str) -> Option<String> {
        if path == "/" {
            return None;
        }

        let (parent, _) = path.rsplit_once('/')?;
        if parent.is_empty() {
            Some("/".to_string())
        } else {
            Some(parent.to_string())
        }
    }

    fn workspace_get_file(&self, path: &str) -> Result<WorkspaceFile, FsError> {
        if let Some(cached) = self.workspace_cache.get_file(path) {
            return cached.ok_or(FsError::NotFound);
        }

        match self
            .rt
            .block_on(ws_queries::get_file(&self.pool, &self.workspace_id, path))
        {
            Ok(file) => {
                self.workspace_cache.set_file(path, Some(file.clone()));
                Ok(file)
            }
            Err(FsError::NotFound) => {
                self.workspace_cache.set_file(path, None);
                Err(FsError::NotFound)
            }
            Err(err) => Err(err),
        }
    }

    fn workspace_list_children(&self, parent_path: &str) -> Result<Vec<WorkspaceFile>, FsError> {
        if let Some(cached) = self.workspace_cache.get_children(parent_path) {
            return Ok(cached);
        }

        let children = self
            .rt
            .block_on(ws_queries::list_children(
                &self.pool,
                &self.workspace_id,
                parent_path,
            ))?;

        for child in &children {
            self.workspace_cache.set_file(&child.path, Some(child.clone()));
        }
        self.workspace_cache
            .set_children(parent_path, children.clone());
        Ok(children)
    }

    fn invalidate_workspace_path(&self, path: &str) {
        self.workspace_cache.invalidate_file(path);
        self.workspace_cache.invalidate_children(path);
        if let Some(parent_path) = Self::parent_path(path) {
            self.workspace_cache.invalidate_children(&parent_path);
        }
    }

    fn db_attr_for_path(&self, path: &str) -> Result<FileAttr, FsError> {
        if path == DB_ROOT {
            return Ok(crate::fs::attr::dir_attr(self.inodes.get_or_insert(DB_ROOT)));
        }

        let identity = self
            .db_identity_for_path(path)
            .ok_or(FsError::NotFound)?;
        let ino = self.inodes.get_or_insert(path);
        let attr = self
            .rt
            .block_on(nodes::node_getattr(&identity, ino, &self.db_ctx()))?;
        Ok(attr)
    }

    fn readdir_root(&self, offset: u64, mut reply: ReplyDirectory) {
        let path = "/".to_string();
        let children = match self.workspace_list_children(&path) {
            Ok(c) => c,
            Err(e) => {
                debug!("sandbox readdir root failed: {}", e);
                reply.error(e.to_errno());
                return;
            }
        };

        let mut idx: u64 = 0;

        if offset <= idx && reply.add(INodeNo(1), idx + 1, FileType::Directory, ".") {
            reply.ok();
            return;
        }
        idx += 1;

        if offset <= idx && reply.add(INodeNo(1), idx + 1, FileType::Directory, "..") {
            reply.ok();
            return;
        }
        idx += 1;

        if offset <= idx {
            let db_ino = self.inodes.get_or_insert(DB_ROOT);
            self.db_nodes
                .entry(DB_ROOT.to_string())
                .or_insert(NodeIdentity::Root);
            if reply.add(INodeNo(db_ino), idx + 1, FileType::Directory, ".db") {
                reply.ok();
                return;
            }
        }
        idx += 1;

        for child in children {
            if offset <= idx {
                let child_path = Self::child_path(&path, &child.name);
                if Self::is_sensitive_path(&child_path) || Self::is_reserved_path(&child_path) {
                    idx += 1;
                    continue;
                }
                let child_ino = self.inodes.get_or_insert(&child_path);
                let kind = if child.is_dir {
                    FileType::Directory
                } else {
                    FileType::RegularFile
                };
                if reply.add(INodeNo(child_ino), idx + 1, kind, &child.name) {
                    break;
                }
            }
            idx += 1;
        }

        reply.ok();
    }

    fn do_flush(&self, fh_u64: u64) -> Result<(), FsError> {
        let handle = self.open_files.get(&fh_u64).ok_or(FsError::NotFound)?;
        let OpenFileKind::Workspace { path } = &handle.kind else {
            return Ok(());
        };

        if handle.dirty {
            let path = path.clone();
            let content = handle.content.clone();
            drop(handle);

            let now_ns = Self::now_ns();
            self.rt.block_on(ws_queries::update_file_content(
                &self.pool,
                &self.workspace_id,
                &path,
                &content,
                now_ns,
            ))?;
            self.invalidate_workspace_path(&path);

            if let Some(mut h) = self.open_files.get_mut(&fh_u64) {
                h.dirty = false;
            }
        }

        Ok(())
    }
}

pub fn mount_at<P: AsRef<Path>>(
    pool: DbPool,
    config: &WorkspaceMountConfig,
    rt: tokio::runtime::Handle,
    mount_point: P,
) -> Result<(), FsError> {
    let fs = SandboxFilesystem::new(pool, config, rt);
    let mut fuse_config = fuser::Config::default();
    // Claude startup fans out many metadata and open calls across /sandbox.
    // With fuser's default single-thread event loop, one slow lookup against
    // the PostgreSQL-backed workspace can stall the whole mount. Use a small
    // multi-thread pool on Linux so unrelated requests can progress.
    fuse_config.n_threads = Some(
        std::thread::available_parallelism()
            .map(|parallelism| parallelism.get().clamp(4, 16))
            .unwrap_or(4),
    );
    fuse_config.clone_fd = true;
    fuse_config.mount_options = vec![
        fuser::MountOption::FSName("openeral-sandbox".to_string()),
        fuser::MountOption::Subtype("openeral".to_string()),
        fuser::MountOption::DefaultPermissions,
        fuser::MountOption::CUSTOM("allow_other".to_string()),
    ];
    fuse_config.acl = fuser::SessionACL::All;

    fuser::mount2(fs, mount_point, &fuse_config).map_err(FsError::IoError)
}

impl Filesystem for SandboxFilesystem {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let parent_ino: u64 = parent.into();
        let parent_path = match self.inodes.get_path(parent_ino) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if parent_path == "/" && name_str == ".db" {
            let db_path = DB_ROOT.to_string();
            let child_ino = self.inodes.get_or_insert(&db_path);
            self.db_nodes
                .entry(db_path)
                .or_insert(NodeIdentity::Root);
            reply.entry(
                &TTL,
                &crate::fs::attr::dir_attr(child_ino),
                Generation(0),
            );
            return;
        }

        if Self::is_db_path(&parent_path) {
            let parent_identity = match self.db_identity_for_path(&parent_path) {
                Some(identity) => identity,
                None => {
                    reply.error(Errno::ENOENT);
                    return;
                }
            };
            let ctx = self.db_ctx();
            match self
                .rt
                .block_on(nodes::node_lookup(&parent_identity, &name_str, &ctx))
            {
                Ok(child_identity) => {
                    let child_path = Self::child_path(&parent_path, &name_str);
                    let child_ino = self.inodes.get_or_insert(&child_path);
                    self.db_nodes.insert(child_path, child_identity.clone());
                    match self
                        .rt
                        .block_on(nodes::node_getattr(&child_identity, child_ino, &ctx))
                    {
                        Ok(mut attr) => {
                            attr.ino = INodeNo(child_ino);
                            reply.entry(&TTL, &attr, Generation(0));
                        }
                        Err(e) => reply.error(e.to_errno()),
                    }
                }
                Err(e) => reply.error(e.to_errno()),
            }
            return;
        }

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }
        if Self::is_reserved_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }

        match self.workspace_get_file(&child_path) {
            Ok(file) => {
                let child_ino = self.inodes.get_or_insert(&child_path);
                let attr = Self::file_to_attr(child_ino, &file);
                reply.entry(&TTL, &attr, Generation(0));
            }
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let ino_u64: u64 = ino.into();
        let path = match self.inodes.get_path(ino_u64) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if Self::is_db_path(&path) {
            match self.db_attr_for_path(&path) {
                Ok(attr) => reply.attr(&TTL, &attr),
                Err(e) => reply.error(e.to_errno()),
            }
            return;
        }

        if Self::is_sensitive_path(&path) {
            reply.error(Errno::EACCES);
            return;
        }

        match self.workspace_get_file(&path) {
            Ok(file) => reply.attr(&TTL, &Self::file_to_attr(ino_u64, &file)),
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn setattr(
        &self,
        _req: &Request,
        ino: INodeNo,
        mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<fuser::BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let ino_u64: u64 = ino.into();
        let path = match self.inodes.get_path(ino_u64) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if Self::is_db_path(&path) {
            reply.error(Errno::EROFS);
            return;
        }
        if Self::is_sensitive_path(&path) {
            reply.error(Errno::EACCES);
            return;
        }

        if let Some(new_size) = size {
            if let Some(fh_val) = fh {
                let fh_u64: u64 = fh_val.into();
                if let Some(mut handle) = self.open_files.get_mut(&fh_u64) {
                    handle.content.resize(new_size as usize, 0);
                    handle.dirty = true;
                }
            }
        }

        let mtime_ns = mtime.map(|t| match t {
            TimeOrNow::SpecificTime(st) => st.duration_since(UNIX_EPOCH).unwrap().as_nanos() as i64,
            TimeOrNow::Now => Self::now_ns(),
        });
        let atime_ns = atime.map(|t| match t {
            TimeOrNow::SpecificTime(st) => st.duration_since(UNIX_EPOCH).unwrap().as_nanos() as i64,
            TimeOrNow::Now => Self::now_ns(),
        });

        match self.rt.block_on(ws_queries::update_file_attrs(
            &self.pool,
            &self.workspace_id,
            &path,
            mode.map(|m| m as i32),
            size.map(|s| s as i64),
            mtime_ns,
            atime_ns,
        )) {
            Ok(file) => {
                self.workspace_cache.set_file(&path, Some(file.clone()));
                reply.attr(&TTL, &Self::file_to_attr(ino_u64, &file))
            }
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn readdir(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        let ino_u64: u64 = ino.into();
        let path = match self.inodes.get_path(ino_u64) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if path == "/" {
            self.readdir_root(offset, reply);
            return;
        }

        if Self::is_db_path(&path) {
            let identity = match self.db_identity_for_path(&path) {
                Some(id) => id,
                None => {
                    reply.error(Errno::ENOENT);
                    return;
                }
            };
            let ctx = self.db_ctx();
            let entries = match self.rt.block_on(nodes::node_readdir(&identity, 0, &ctx)) {
                Ok(entries) => entries,
                Err(e) => {
                    reply.error(e.to_errno());
                    return;
                }
            };

            let mut idx: u64 = 0;
            if offset <= idx && reply.add(INodeNo(ino_u64), idx + 1, FileType::Directory, ".") {
                reply.ok();
                return;
            }
            idx += 1;
            if offset <= idx && reply.add(INodeNo(1), idx + 1, FileType::Directory, "..") {
                reply.ok();
                return;
            }
            idx += 1;

            for entry in entries {
                if offset <= idx {
                    let child_path = Self::child_path(&path, &entry.name);
                    let child_ino = self.inodes.get_or_insert(&child_path);
                    self.db_nodes.insert(child_path, entry.identity);
                    if reply.add(INodeNo(child_ino), idx + 1, entry.kind, &entry.name) {
                        break;
                    }
                }
                idx += 1;
            }
            reply.ok();
            return;
        }

        let children = match self.workspace_list_children(&path) {
            Ok(c) => c,
            Err(e) => {
                reply.error(e.to_errno());
                return;
            }
        };

        let mut idx: u64 = 0;
        if offset <= idx && reply.add(INodeNo(ino_u64), idx + 1, FileType::Directory, ".") {
            reply.ok();
            return;
        }
        idx += 1;
        if offset <= idx && reply.add(INodeNo(1), idx + 1, FileType::Directory, "..") {
            reply.ok();
            return;
        }
        idx += 1;

        for child in children {
            if offset <= idx {
                let child_path = Self::child_path(&path, &child.name);
                if Self::is_sensitive_path(&child_path) || Self::is_reserved_path(&child_path) {
                    idx += 1;
                    continue;
                }
                let child_ino = self.inodes.get_or_insert(&child_path);
                let kind = if child.is_dir {
                    FileType::Directory
                } else {
                    FileType::RegularFile
                };
                if reply.add(INodeNo(child_ino), idx + 1, kind, &child.name) {
                    break;
                }
            }
            idx += 1;
        }
        reply.ok();
    }

    fn open(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let ino_u64: u64 = ino.into();
        let path = match self.inodes.get_path(ino_u64) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if Self::is_db_path(&path) {
            if path == DB_ROOT {
                reply.error(Errno::EISDIR);
                return;
            }
            let identity = match self.db_identity_for_path(&path) {
                Some(identity) => identity,
                None => {
                    reply.error(Errno::ENOENT);
                    return;
                }
            };
            match self
                .rt
                .block_on(nodes::node_read(&identity, 0, u32::MAX, &self.db_ctx()))
            {
                Ok(content) => {
                    let fh = self.alloc_fh();
                    self.open_files.insert(
                        fh,
                        OpenFileHandle {
                            kind: OpenFileKind::ReadOnly,
                            content,
                            dirty: false,
                        },
                    );
                    reply.opened(FileHandle(fh), FopenFlags::empty());
                }
                Err(e) => reply.error(e.to_errno()),
            }
            return;
        }

        if Self::is_sensitive_path(&path) {
            reply.error(Errno::EACCES);
            return;
        }

        match self.workspace_get_file(&path) {
            Ok(file) => {
                if file.is_dir {
                    reply.error(Errno::EISDIR);
                    return;
                }
                let fh = self.alloc_fh();
                self.open_files.insert(
                    fh,
                    OpenFileHandle {
                        kind: OpenFileKind::Workspace { path },
                        content: file.content.unwrap_or_default(),
                        dirty: false,
                    },
                );
                reply.opened(FileHandle(fh), FopenFlags::empty());
            }
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn read(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<fuser::LockOwner>,
        reply: ReplyData,
    ) {
        let fh_u64: u64 = fh.into();
        if let Some(handle) = self.open_files.get(&fh_u64) {
            let content = &handle.content;
            let offset = offset as usize;
            if offset >= content.len() {
                reply.data(&[]);
            } else {
                let end = (offset + size as usize).min(content.len());
                reply.data(&content[offset..end]);
            }
        } else {
            reply.error(Errno::EBADF);
        }
    }

    fn write(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _lock_owner: Option<fuser::LockOwner>,
        reply: ReplyWrite,
    ) {
        let fh_u64: u64 = fh.into();
        if let Some(mut handle) = self.open_files.get_mut(&fh_u64) {
            if matches!(handle.kind, OpenFileKind::ReadOnly) {
                reply.error(Errno::EROFS);
                return;
            }
            let offset = offset as usize;
            let end = offset + data.len();
            if end > handle.content.len() {
                handle.content.resize(end, 0);
            }
            handle.content[offset..end].copy_from_slice(data);
            handle.dirty = true;
            reply.written(data.len() as u32);
        } else {
            reply.error(Errno::EBADF);
        }
    }

    fn flush(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _lock_owner: fuser::LockOwner,
        reply: ReplyEmpty,
    ) {
        match self.do_flush(fh.into()) {
            Ok(()) => reply.ok(),
            Err(e) => {
                warn!("sandbox flush failed: {}", e);
                reply.error(e.to_errno());
            }
        }
    }

    fn release(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<fuser::LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let fh_u64: u64 = fh.into();
        if let Some(handle) = self.open_files.get(&fh_u64) {
            if handle.dirty {
                drop(handle);
                if let Err(e) = self.do_flush(fh_u64) {
                    warn!("sandbox release flush failed: {}", e);
                    self.open_files.remove(&fh_u64);
                    reply.error(e.to_errno());
                    return;
                }
            }
        }
        self.open_files.remove(&fh_u64);
        reply.ok();
    }

    fn create(
        &self,
        req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::EINVAL);
                return;
            }
        };

        let parent_path = match self.inodes.get_path(parent.into()) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if Self::is_db_path(&parent_path) {
            reply.error(Errno::EROFS);
            return;
        }

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }
        if Self::is_reserved_path(&child_path) {
            reply.error(Errno::EEXIST);
            return;
        }

        let now_ns = Self::now_ns();
        let file = WorkspaceFile {
            workspace_id: self.workspace_id.clone(),
            path: child_path.clone(),
            parent_path: parent_path.clone(),
            name: name_str,
            is_dir: false,
            content: Some(Vec::new()),
            mode: mode as i32,
            size: 0,
            mtime_ns: now_ns,
            ctime_ns: now_ns,
            atime_ns: now_ns,
            nlink: 1,
            uid: req.uid() as i32,
            gid: req.gid() as i32,
        };

        match self.rt.block_on(ws_queries::create_file(&self.pool, &file)) {
            Ok(()) => {
                self.workspace_cache.set_file(&child_path, Some(file.clone()));
                self.workspace_cache.invalidate_children(&parent_path);
                let child_ino = self.inodes.get_or_insert(&child_path);
                let attr = Self::file_to_attr(child_ino, &file);
                let fh = self.alloc_fh();
                self.open_files.insert(
                    fh,
                    OpenFileHandle {
                        kind: OpenFileKind::Workspace { path: child_path },
                        content: Vec::new(),
                        dirty: false,
                    },
                );
                reply.created(
                    &TTL,
                    &attr,
                    Generation(0),
                    FileHandle(fh),
                    FopenFlags::empty(),
                );
            }
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn mkdir(
        &self,
        req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::EINVAL);
                return;
            }
        };

        let parent_path = match self.inodes.get_path(parent.into()) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if Self::is_db_path(&parent_path) {
            reply.error(Errno::EROFS);
            return;
        }

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }
        if Self::is_reserved_path(&child_path) {
            reply.error(Errno::EEXIST);
            return;
        }

        let now_ns = Self::now_ns();
        let dir = WorkspaceFile {
            workspace_id: self.workspace_id.clone(),
            path: child_path.clone(),
            parent_path: parent_path.clone(),
            name: name_str,
            is_dir: true,
            content: None,
            mode: (mode | 0o40000) as i32,
            size: 0,
            mtime_ns: now_ns,
            ctime_ns: now_ns,
            atime_ns: now_ns,
            nlink: 2,
            uid: req.uid() as i32,
            gid: req.gid() as i32,
        };

        match self.rt.block_on(ws_queries::create_file(&self.pool, &dir)) {
            Ok(()) => {
                self.workspace_cache.set_file(&child_path, Some(dir.clone()));
                self.workspace_cache.invalidate_children(&parent_path);
                let child_ino = self.inodes.get_or_insert(&child_path);
                let attr = Self::file_to_attr(child_ino, &dir);
                reply.entry(&TTL, &attr, Generation(0));
            }
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };
        let parent_path = match self.inodes.get_path(parent.into()) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };
        if Self::is_db_path(&parent_path) {
            reply.error(Errno::EROFS);
            return;
        }

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }
        if Self::is_reserved_path(&child_path) {
            reply.error(Errno::EROFS);
            return;
        }

        match self.rt.block_on(ws_queries::delete_file(
            &self.pool,
            &self.workspace_id,
            &child_path,
        )) {
            Ok(()) => {
                self.invalidate_workspace_path(&child_path);
                self.inodes.remove(&child_path);
                reply.ok();
            }
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };
        let parent_path = match self.inodes.get_path(parent.into()) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };
        if Self::is_db_path(&parent_path) {
            reply.error(Errno::EROFS);
            return;
        }

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }
        if Self::is_reserved_path(&child_path) {
            reply.error(Errno::EROFS);
            return;
        }

        match self.rt.block_on(ws_queries::delete_directory(
            &self.pool,
            &self.workspace_id,
            &child_path,
        )) {
            Ok(()) => {
                self.invalidate_workspace_path(&child_path);
                self.inodes.remove(&child_path);
                reply.ok();
            }
            Err(e) => reply.error(e.to_errno()),
        }
    }

    fn rename(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        _flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::EINVAL);
                return;
            }
        };
        let newname_str = match newname.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::EINVAL);
                return;
            }
        };

        let parent_path = match self.inodes.get_path(parent.into()) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };
        let newparent_path = match self.inodes.get_path(newparent.into()) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if Self::is_db_path(&parent_path) || Self::is_db_path(&newparent_path) {
            reply.error(Errno::EROFS);
            return;
        }

        let old_path = Self::child_path(&parent_path, &name_str);
        let new_path = Self::child_path(&newparent_path, &newname_str);
        if Self::is_sensitive_path(&old_path) || Self::is_sensitive_path(&new_path) {
            reply.error(Errno::EACCES);
            return;
        }
        if Self::is_reserved_path(&old_path) || Self::is_reserved_path(&new_path) {
            reply.error(Errno::EROFS);
            return;
        }

        let is_dir = match self.workspace_get_file(&old_path) {
            Ok(f) => f.is_dir,
            Err(e) => {
                reply.error(e.to_errno());
                return;
            }
        };

        if let Err(e) = self.rt.block_on(ws_queries::rename_file(
            &self.pool,
            &self.workspace_id,
            &old_path,
            &new_path,
            &newparent_path,
            &newname_str,
        )) {
            reply.error(e.to_errno());
            return;
        }

        if is_dir {
            if let Err(e) = self.rt.block_on(ws_queries::rename_tree(
                &self.pool,
                &self.workspace_id,
                &old_path,
                &new_path,
            )) {
                warn!("sandbox rename_tree failed: {}", e);
            }
        }

        self.workspace_cache.invalidate_all();
        self.inodes.rename(&old_path, &new_path);
        reply.ok();
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let ino_u64: u64 = ino.into();
        if self.inodes.get_path(ino_u64).is_some() {
            reply.opened(FileHandle(0), FopenFlags::empty());
        } else {
            reply.error(Errno::ENOENT);
        }
    }

    fn releasedir(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _flags: OpenFlags,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }
}

#[cfg(test)]
mod tests {
    use super::SandboxFilesystem;

    #[test]
    fn sensitive_home_paths_are_denied() {
        for path in [
            "/.ssh",
            "/.ssh/id_rsa",
            "/project/.aws/config",
            "/.npmrc",
            "/.bash_history",
            "/.local/share/keyrings/login.keyring",
        ] {
            assert!(SandboxFilesystem::is_sensitive_path(path), "{path}");
        }
    }

    #[test]
    fn reserved_db_paths_are_not_sensitive() {
        assert!(!SandboxFilesystem::is_sensitive_path("/.db"));
        assert!(!SandboxFilesystem::is_sensitive_path("/.db/public/users/.info/count"));
        assert!(SandboxFilesystem::is_reserved_path("/.db"));
        assert!(SandboxFilesystem::is_reserved_path("/.db/public"));
    }
}
