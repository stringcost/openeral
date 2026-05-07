use std::ffi::OsStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use fuser::{
    Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, OpenFlags,
    RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry,
    ReplyOpen, ReplyWrite, Request, TimeOrNow, WriteFlags,
};
use tracing::{debug, warn};

use crate::config::types::WorkspaceMountConfig;
use crate::db::pool::DbPool;
use crate::db::queries::workspace as ws_queries;
use crate::db::types::WorkspaceFile;
use crate::error::FsError;
use crate::fs::attr::BLOCK_SIZE;
use crate::fs::workspace_inode::WorkspaceInodeTable;

const TTL: Duration = Duration::from_secs(1);

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

/// Tracks an open file handle with write-back buffering.
struct OpenFileHandle {
    path: String,
    content: Vec<u8>,
    dirty: bool,
}

/// A read-write FUSE filesystem backed by PostgreSQL workspace tables.
/// Each workspace is an isolated set of files stored in `_openeral.workspace_files`.
pub struct WorkspaceFilesystem {
    rt: tokio::runtime::Handle,
    pool: DbPool,
    workspace_id: String,
    inodes: WorkspaceInodeTable,
    open_files: DashMap<u64, OpenFileHandle>,
    next_fh: std::sync::atomic::AtomicU64,
}

impl WorkspaceFilesystem {
    pub fn new(pool: DbPool, config: &WorkspaceMountConfig, rt: tokio::runtime::Handle) -> Self {
        Self {
            rt,
            pool,
            workspace_id: config.workspace_id.clone(),
            inodes: WorkspaceInodeTable::new(),
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

    /// Build the full path for a child under a parent path.
    fn child_path(parent_path: &str, name: &str) -> String {
        if parent_path == "/" {
            format!("/{}", name)
        } else {
            format!("{}/{}", parent_path, name)
        }
    }

    fn is_sensitive_path(path: &str) -> bool {
        if path == "/" {
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

    fn do_flush(&self, fh_u64: u64) -> Result<(), FsError> {
        let handle = self.open_files.get(&fh_u64).ok_or(FsError::NotFound)?;
        if handle.dirty {
            let path = handle.path.clone();
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

            if let Some(mut h) = self.open_files.get_mut(&fh_u64) {
                h.dirty = false;
            }
        }
        Ok(())
    }
}

impl Filesystem for WorkspaceFilesystem {
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

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }
        match self.rt.block_on(ws_queries::get_file(
            &self.pool,
            &self.workspace_id,
            &child_path,
        )) {
            Ok(file) => {
                let child_ino = self.inodes.get_or_insert(&child_path);
                let attr = Self::file_to_attr(child_ino, &file);
                reply.entry(&TTL, &attr, Generation(0));
            }
            Err(e) => {
                debug!(
                    "workspace lookup({}, {:?}) failed: {}",
                    parent_ino, name_str, e
                );
                reply.error(e.to_errno());
            }
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
        if Self::is_sensitive_path(&path) {
            reply.error(Errno::EACCES);
            return;
        }

        match self
            .rt
            .block_on(ws_queries::get_file(&self.pool, &self.workspace_id, &path))
        {
            Ok(file) => {
                let attr = Self::file_to_attr(ino_u64, &file);
                reply.attr(&TTL, &attr);
            }
            Err(e) => {
                debug!("workspace getattr({}) failed: {}", ino_u64, e);
                reply.error(e.to_errno());
            }
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
        if Self::is_sensitive_path(&path) {
            reply.error(Errno::EACCES);
            return;
        }

        // If truncating and we have an open file handle, update the buffer too
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
                let attr = Self::file_to_attr(ino_u64, &file);
                reply.attr(&TTL, &attr);
            }
            Err(e) => {
                debug!("workspace setattr({}) failed: {}", ino_u64, e);
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
        let path = match self.inodes.get_path(ino_u64) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let children = match self.rt.block_on(ws_queries::list_children(
            &self.pool,
            &self.workspace_id,
            &path,
        )) {
            Ok(c) => c,
            Err(e) => {
                debug!("workspace readdir({}) failed: {}", ino_u64, e);
                reply.error(e.to_errno());
                return;
            }
        };

        let mut idx: u64 = 0;

        // "."
        if offset <= idx && reply.add(INodeNo(ino_u64), idx + 1, FileType::Directory, ".") {
            reply.ok();
            return;
        }
        idx += 1;

        // ".."
        if offset <= idx && reply.add(INodeNo(1), idx + 1, FileType::Directory, "..") {
            reply.ok();
            return;
        }
        idx += 1;

        for child in children {
            if offset <= idx {
                let child_path = Self::child_path(&path, &child.name);
                if Self::is_sensitive_path(&child_path) {
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
        if Self::is_sensitive_path(&path) {
            reply.error(Errno::EACCES);
            return;
        }

        match self
            .rt
            .block_on(ws_queries::get_file(&self.pool, &self.workspace_id, &path))
        {
            Ok(file) => {
                if file.is_dir {
                    reply.error(Errno::EISDIR);
                    return;
                }
                let fh = self.alloc_fh();
                let content = file.content.unwrap_or_default();
                self.open_files.insert(
                    fh,
                    OpenFileHandle {
                        path,
                        content,
                        dirty: false,
                    },
                );
                reply.opened(FileHandle(fh), FopenFlags::empty());
            }
            Err(e) => {
                debug!("workspace open({}) failed: {}", ino_u64, e);
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
            let offset = offset as usize;
            let end = offset + data.len();

            // Extend buffer if needed
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
        let fh_u64: u64 = fh.into();
        match self.do_flush(fh_u64) {
            Ok(()) => reply.ok(),
            Err(e) => {
                warn!("workspace flush failed: {}", e);
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

        // Flush if dirty before releasing
        if let Some(handle) = self.open_files.get(&fh_u64) {
            if handle.dirty {
                drop(handle);
                if let Err(e) = self.do_flush(fh_u64) {
                    warn!("workspace release flush failed: {}", e);
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

        let parent_ino: u64 = parent.into();
        let parent_path = match self.inodes.get_path(parent_ino) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
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
                let child_ino = self.inodes.get_or_insert(&child_path);
                let attr = Self::file_to_attr(child_ino, &file);
                let fh = self.alloc_fh();
                self.open_files.insert(
                    fh,
                    OpenFileHandle {
                        path: child_path,
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
            Err(e) => {
                debug!("workspace create failed: {}", e);
                reply.error(e.to_errno());
            }
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

        let parent_ino: u64 = parent.into();
        let parent_path = match self.inodes.get_path(parent_ino) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
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
                let child_ino = self.inodes.get_or_insert(&child_path);
                let attr = Self::file_to_attr(child_ino, &dir);
                reply.entry(&TTL, &attr, Generation(0));
            }
            Err(e) => {
                debug!("workspace mkdir failed: {}", e);
                reply.error(e.to_errno());
            }
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

        let parent_ino: u64 = parent.into();
        let parent_path = match self.inodes.get_path(parent_ino) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }

        match self.rt.block_on(ws_queries::delete_file(
            &self.pool,
            &self.workspace_id,
            &child_path,
        )) {
            Ok(()) => {
                self.inodes.remove(&child_path);
                reply.ok();
            }
            Err(e) => {
                debug!("workspace unlink failed: {}", e);
                reply.error(e.to_errno());
            }
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

        let parent_ino: u64 = parent.into();
        let parent_path = match self.inodes.get_path(parent_ino) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let child_path = Self::child_path(&parent_path, &name_str);
        if Self::is_sensitive_path(&child_path) {
            reply.error(Errno::EACCES);
            return;
        }

        match self.rt.block_on(ws_queries::delete_directory(
            &self.pool,
            &self.workspace_id,
            &child_path,
        )) {
            Ok(()) => {
                self.inodes.remove(&child_path);
                reply.ok();
            }
            Err(e) => {
                debug!("workspace rmdir failed: {}", e);
                reply.error(e.to_errno());
            }
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

        let parent_ino: u64 = parent.into();
        let newparent_ino: u64 = newparent.into();

        let parent_path = match self.inodes.get_path(parent_ino) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };
        let newparent_path = match self.inodes.get_path(newparent_ino) {
            Some(p) => p,
            None => {
                reply.error(Errno::ENOENT);
                return;
            }
        };

        let old_path = Self::child_path(&parent_path, &name_str);
        let new_path = Self::child_path(&newparent_path, &newname_str);
        if Self::is_sensitive_path(&old_path) || Self::is_sensitive_path(&new_path) {
            reply.error(Errno::EACCES);
            return;
        }

        // Check if the source is a directory (need to rename the tree too)
        let is_dir = match self.rt.block_on(ws_queries::get_file(
            &self.pool,
            &self.workspace_id,
            &old_path,
        )) {
            Ok(f) => f.is_dir,
            Err(e) => {
                reply.error(e.to_errno());
                return;
            }
        };

        // Rename the file/dir itself
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

        // If directory, also rename all descendants
        if is_dir {
            if let Err(e) = self.rt.block_on(ws_queries::rename_tree(
                &self.pool,
                &self.workspace_id,
                &old_path,
                &new_path,
            )) {
                warn!("workspace rename_tree failed: {}", e);
                // The parent was already renamed, so reply OK but log the error
            }
        }

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
    use super::WorkspaceFilesystem;

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
            assert!(WorkspaceFilesystem::is_sensitive_path(path), "{path}");
        }
    }

    #[test]
    fn agent_state_paths_remain_persistent() {
        for path in [
            "/.claude/settings.json",
            "/.claude/projects/session.json",
            "/.openeral/presign.json",
            "/work/file.txt",
        ] {
            assert!(!WorkspaceFilesystem::is_sensitive_path(path), "{path}");
        }
    }
}
