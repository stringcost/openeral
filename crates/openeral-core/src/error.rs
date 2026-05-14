use fuser::Errno;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FsError {
    #[error("No such file or directory")]
    NotFound,

    #[error("Permission denied")]
    PermissionDenied,

    #[error("Not a directory")]
    NotADirectory,

    #[error("Is a directory")]
    IsADirectory,

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    #[error("Read-only filesystem")]
    ReadOnlyFilesystem,

    #[error("File exists")]
    FileExists,

    #[error("Directory not empty")]
    DirectoryNotEmpty,

    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Database error: {0}")]
    DatabaseError(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Internal error: {0}")]
    InternalError(String),
}

impl FsError {
    pub fn to_errno(&self) -> Errno {
        match self {
            FsError::NotFound => Errno::ENOENT,
            FsError::PermissionDenied => Errno::EACCES,
            FsError::NotADirectory => Errno::ENOTDIR,
            FsError::IsADirectory => Errno::EISDIR,
            FsError::InvalidArgument(_) => Errno::EINVAL,
            FsError::ReadOnlyFilesystem => Errno::EROFS,
            FsError::FileExists => Errno::EEXIST,
            FsError::DirectoryNotEmpty => Errno::ENOTEMPTY,
            FsError::IoError(_) => Errno::EIO,
            FsError::DatabaseError(_) => Errno::EIO,
            FsError::SerializationError(_) => Errno::EIO,
            FsError::InternalError(_) => Errno::EIO,
        }
    }
}

impl From<tokio_postgres::Error> for FsError {
    fn from(err: tokio_postgres::Error) -> Self {
        if let Some(db) = err.as_db_error() {
            let mut message = format!("{} (sqlstate {})", db.message(), db.code().code());
            if let Some(detail) = db.detail() {
                message.push_str(&format!(" detail: {}", detail));
            }
            if let Some(hint) = db.hint() {
                message.push_str(&format!(" hint: {}", hint));
            }
            FsError::DatabaseError(message)
        } else {
            FsError::DatabaseError(err.to_string())
        }
    }
}
