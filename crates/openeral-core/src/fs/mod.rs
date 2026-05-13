pub mod attr;
pub mod cache;
pub mod inode;
pub mod sandbox;
pub mod nodes;
pub mod workspace;
pub mod workspace_inode;

use std::ffi::OsStr;
use std::time::Duration;

use dashmap::DashMap;
use fuser::{
    Errno, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, OpenFlags, ReplyAttr,
    ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, Request,
};
use tracing::debug;

use crate::config::types::MountConfig;
use crate::db::pool::DbPool;
use crate::fs::cache::MetadataCache;
use crate::fs::inode::InodeTable;
use crate::fs::nodes::NodeContext;

const TTL: Duration = Duration::from_secs(1);

/// Tracks open file handles and their cached content
struct OpenFileHandle {
    content: Vec<u8>,
}

/// The main FUSE filesystem implementation.
/// Bridges sync fuser callbacks to async tokio-postgres via `rt.block_on()`.
pub struct PgmountFilesystem {
    rt: tokio::runtime::Handle,
    pool: DbPool,
    inodes: InodeTable,
    cache: MetadataCache,
    config: MountConfig,
    /// Maps file handle → cached content for open files
    open_files: DashMap<u64, OpenFileHandle>,
    next_fh: std::sync::atomic::AtomicU64,
}

impl PgmountFilesystem {
    pub fn new(pool: DbPool, config: MountConfig, rt: tokio::runtime::Handle) -> Self {
        let cache = MetadataCache::new(config.cache_ttl);
        Self {
            rt,
            pool,
            inodes: InodeTable::new(),
            cache,
            config,
            open_files: DashMap::new(),
            next_fh: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn ctx(&self) -> NodeContext<'_> {
        NodeContext {
            pool: &self.pool,
            cache: &self.cache,
            inodes: &self.inodes,
            config: &self.config,
        }
    }

    fn alloc_fh(&self) -> u64 {
        self.next_fh
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }
}

impl Filesystem for PgmountFilesystem {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let name_str = match name.to_str() {
            Some(s) => s.to_string(),
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let parent_ino: u64 = parent.into();
        let parent_identity = match self.inodes.get_identity(parent_ino) {
            Some(id) => id,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let ctx = self.ctx();
        match self
            .rt
            .block_on(nodes::node_lookup(&parent_identity, &name_str, &ctx))
        {
            Ok(child_identity) => {
                let child_ino = self.inodes.get_or_insert(child_identity.clone());
                match self
                    .rt
                    .block_on(nodes::node_getattr(&child_identity, child_ino, &ctx))
                {
                    Ok(attr) => {
                        let mut fuse_attr = attr;
                        fuse_attr.ino = INodeNo(child_ino);
                        reply.entry(&TTL, &fuse_attr, Generation(0));
                    }
                    Err(e) => {
                        debug!("getattr failed for {:?}: {}", child_identity, e);
                        reply.error(e.to_errno());
                    }
                }
            }
            Err(e) => {
                debug!("lookup({}, {:?}) failed: {}", parent_ino, name_str, e);
                reply.error(e.to_errno());
            }
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        let ino_u64: u64 = ino.into();
        let identity = match self.inodes.get_identity(ino_u64) {
            Some(id) => id,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let ctx = self.ctx();
        match self
            .rt
            .block_on(nodes::node_getattr(&identity, ino_u64, &ctx))
        {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => {
                debug!("getattr({}) failed: {}", ino_u64, e);
                reply.error(e.to_errno());
            }
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
        let identity = match self.inodes.get_identity(ino_u64) {
            Some(id) => id,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        // Build the full list of entries: . , .. , then node entries
        // We use offset as an index into this combined list.
        let ctx = self.ctx();
        let node_entries = match self.rt.block_on(nodes::node_readdir(&identity, 0, &ctx)) {
            Ok(entries) => entries,
            Err(e) => {
                debug!("readdir({}) failed: {}", ino_u64, e);
                reply.error(e.to_errno());
                return;
            }
        };

        // Resolve all child inodes and build a combined entry list
        // Entry 0 = ".", Entry 1 = "..", Entry 2+ = node entries
        let mut idx: u64 = 0;

        // Skip entries before offset
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

        for entry in node_entries {
            if offset <= idx {
                let child_ino = self.inodes.get_or_insert(entry.identity);
                if reply.add(INodeNo(child_ino), idx + 1, entry.kind, &entry.name) {
                    break; // Buffer full
                }
            }
            idx += 1;
        }
        reply.ok();
    }

    fn open(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let ino_u64: u64 = ino.into();
        let identity = match self.inodes.get_identity(ino_u64) {
            Some(id) => id,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        if nodes::is_directory(&identity) {
            reply.error(Errno::EISDIR);
            return;
        }

        // Pre-generate content and cache it in a file handle
        let ctx = self.ctx();
        match self
            .rt
            .block_on(nodes::node_read(&identity, 0, u32::MAX, &ctx))
        {
            Ok(content) => {
                let fh = self.alloc_fh();
                self.open_files.insert(fh, OpenFileHandle { content });
                reply.opened(FileHandle(fh), FopenFlags::empty());
            }
            Err(e) => {
                debug!("open({}) failed: {}", ino_u64, e);
                reply.error(e.to_errno());
            }
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
        self.open_files.remove(&fh_u64);
        reply.ok();
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        let ino_u64: u64 = ino.into();
        if self.inodes.get_identity(ino_u64).is_some() {
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
