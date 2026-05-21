use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};

/// Maps workspace file paths to inode numbers and vice versa.
/// Simpler than NodeIdentity-based InodeTable — uses String paths directly.
pub struct WorkspaceInodeTable {
    path_to_ino: DashMap<String, u64>,
    ino_to_path: DashMap<u64, String>,
    next_ino: AtomicU64,
}

impl Default for WorkspaceInodeTable {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceInodeTable {
    pub fn new() -> Self {
        let table = Self {
            path_to_ino: DashMap::new(),
            ino_to_path: DashMap::new(),
            next_ino: AtomicU64::new(2), // 1 is reserved for root
        };
        // Pre-register root
        table.path_to_ino.insert("/".to_string(), 1);
        table.ino_to_path.insert(1, "/".to_string());
        table
    }

    /// Get or allocate an inode for the given path.
    pub fn get_or_insert(&self, path: &str) -> u64 {
        if let Some(ino) = self.path_to_ino.get(path) {
            return *ino;
        }
        let ino = self.next_ino.fetch_add(1, Ordering::Relaxed);
        self.path_to_ino.insert(path.to_string(), ino);
        self.ino_to_path.insert(ino, path.to_string());
        ino
    }

    /// Look up path by inode number.
    pub fn get_path(&self, ino: u64) -> Option<String> {
        self.ino_to_path.get(&ino).map(|r| r.clone())
    }

    /// Look up inode by path.
    pub fn get_ino(&self, path: &str) -> Option<u64> {
        self.path_to_ino.get(path).map(|r| *r)
    }

    /// Remove a path mapping (used on unlink/rmdir).
    pub fn remove(&self, path: &str) {
        if let Some((_, ino)) = self.path_to_ino.remove(path) {
            self.ino_to_path.remove(&ino);
        }
    }

    /// Rename: keep the moved node's inode stable at its new path.
    pub fn rename(&self, old_path: &str, new_path: &str) {
        let old_ino = self.path_to_ino.remove(old_path).map(|(_, ino)| ino);
        if let Some((_, overwritten_ino)) = self.path_to_ino.remove(new_path) {
            self.ino_to_path.remove(&overwritten_ino);
        }

        if let Some(ino) = old_ino {
            self.path_to_ino.insert(new_path.to_string(), ino);
            self.ino_to_path.insert(ino, new_path.to_string());
        } else {
            self.get_or_insert(new_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceInodeTable;

    #[test]
    fn rename_preserves_source_inode() {
        let table = WorkspaceInodeTable::new();
        let old_ino = table.get_or_insert("/.claude/.claude.json");

        table.rename(
            "/.claude/.claude.json",
            "/.claude/backups/.claude.json.backup",
        );

        assert_eq!(
            table.get_ino("/.claude/backups/.claude.json.backup"),
            Some(old_ino)
        );
        assert_eq!(
            table.get_path(old_ino),
            Some("/.claude/backups/.claude.json.backup".to_string())
        );
        assert_eq!(table.get_ino("/.claude/.claude.json"), None);
    }

    #[test]
    fn rename_drops_overwritten_destination_inode() {
        let table = WorkspaceInodeTable::new();
        let old_ino = table.get_or_insert("/tmp/new-config");
        let overwritten_ino = table.get_or_insert("/.claude/.claude.json");

        table.rename("/tmp/new-config", "/.claude/.claude.json");

        assert_eq!(table.get_ino("/.claude/.claude.json"), Some(old_ino));
        assert_eq!(
            table.get_path(old_ino),
            Some("/.claude/.claude.json".to_string())
        );
        assert_eq!(table.get_path(overwritten_ino), None);
    }

    #[test]
    fn remove_drops_path_and_inode_mapping() {
        let table = WorkspaceInodeTable::new();
        let ino = table.get_or_insert("/.claude/session.json");

        table.remove("/.claude/session.json");

        assert_eq!(table.get_ino("/.claude/session.json"), None);
        assert_eq!(table.get_path(ino), None);
    }

    #[test]
    fn rename_missing_source_allocates_destination_inode() {
        let table = WorkspaceInodeTable::new();

        table.rename("/missing", "/created-by-rename");

        let ino = table
            .get_ino("/created-by-rename")
            .expect("destination inode should be allocated");
        assert_eq!(table.get_path(ino), Some("/created-by-rename".to_string()));
    }
}
