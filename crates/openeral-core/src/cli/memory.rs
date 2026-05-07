use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use clap::{Parser, Subcommand};

use crate::error::FsError;

#[derive(Parser, Debug)]
pub struct MemoryArgs {
    #[command(subcommand)]
    pub command: MemoryCommand,
}

#[derive(Subcommand, Debug)]
pub enum MemoryCommand {
    /// Refresh Claude memory files for the current project.
    Refresh(RefreshArgs),
}

#[derive(Parser, Debug)]
pub struct RefreshArgs {
    /// FUSE-backed home directory.
    #[arg(long)]
    pub home: Option<PathBuf>,

    /// Project root to summarize. Defaults to git root, then current directory.
    #[arg(long)]
    pub project_root: Option<PathBuf>,

    /// Optional focus query for a narrower memory file.
    #[arg(long)]
    pub query: Option<String>,

    /// Preview the target files without writing them.
    #[arg(long)]
    pub dry_run: bool,

    /// Skip backing up existing markdown memory files.
    #[arg(long)]
    pub no_backup: bool,
}

pub async fn execute(args: MemoryArgs) -> Result<(), FsError> {
    match args.command {
        MemoryCommand::Refresh(args) => refresh(args),
    }
}

fn refresh(args: RefreshArgs) -> Result<(), FsError> {
    let home = args
        .home
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/home/agent"));
    let cwd = std::env::current_dir()?;
    let project_root = if let Some(project_root) = args.project_root {
        project_root
    } else {
        git_root(&cwd).unwrap_or_else(|_| cwd.clone())
    };
    let project_root = fs::canonicalize(project_root)?;
    let memory_dir = home
        .join(".claude/projects")
        .join(slugify_project_path(&project_root))
        .join("memory");

    let docs = collect_project_docs(&project_root)?;
    let query = args
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());
    let files = render_memory_files(&project_root, &docs, query);

    if args.dry_run {
        println!(
            "Would write {} memory files to {}",
            files.len(),
            memory_dir.display()
        );
        for (name, _) in &files {
            println!("  {name}");
        }
        return Ok(());
    }

    if !args.no_backup {
        backup_existing_memory(&memory_dir)?;
    }

    fs::create_dir_all(&memory_dir)?;
    remove_existing_memory_markdown(&memory_dir)?;
    for (name, content) in files {
        fs::write(memory_dir.join(name), content)?;
    }
    println!("Memory refreshed at {}", memory_dir.display());
    Ok(())
}

fn git_root(cwd: &Path) -> Result<PathBuf, FsError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if text.is_empty() {
                Err(FsError::NotFound)
            } else {
                Ok(PathBuf::from(text))
            }
        }
        _ => Err(FsError::NotFound),
    }
}

fn slugify_project_path(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let slug = raw.replace('/', "-");
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

#[derive(Debug)]
struct ProjectDoc {
    rel_path: PathBuf,
    content: String,
}

fn collect_project_docs(root: &Path) -> Result<Vec<ProjectDoc>, FsError> {
    let mut docs = Vec::new();
    collect_project_docs_recursive(root, root, &mut docs)?;
    docs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(docs)
}

fn collect_project_docs_recursive(
    root: &Path,
    dir: &Path,
    docs: &mut Vec<ProjectDoc>,
) -> Result<(), FsError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        if entry.file_type()?.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            collect_project_docs_recursive(root, &path, docs)?;
            continue;
        }
        if !should_collect_file(&path) {
            continue;
        }
        let rel_path = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        docs.push(ProjectDoc { rel_path, content });
        if docs.len() >= 128 {
            break;
        }
    }
    Ok(())
}

fn should_skip_dir(name: &OsStr) -> bool {
    matches!(
        name.to_string_lossy().as_ref(),
        ".git" | ".claude" | ".openeral" | "node_modules" | "target" | "dist" | "build"
    )
}

fn should_collect_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        || matches!(
            lower.as_str(),
            "agents.md" | "claude.md" | "readme" | "cargo.toml" | "package.json" | "pyproject.toml"
        )
}

fn render_memory_files(
    project_root: &Path,
    docs: &[ProjectDoc],
    query: Option<&str>,
) -> Vec<(String, String)> {
    let selected = select_docs(docs, query);
    let mut files = Vec::new();
    files.push((
        "MEMORY.md".to_string(),
        render_index(project_root, &selected, query),
    ));
    files.push((
        if query.is_some() {
            "focus-context.md".to_string()
        } else {
            "project-context.md".to_string()
        },
        render_context_file(project_root, &selected, query),
    ));
    files
}

fn select_docs<'a>(docs: &'a [ProjectDoc], query: Option<&str>) -> Vec<&'a ProjectDoc> {
    let mut scored: Vec<(usize, &ProjectDoc)> = docs
        .iter()
        .map(|doc| (score_doc(doc, query), doc))
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|(a_score, a), (b_score, b)| {
        b_score
            .cmp(a_score)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    scored.into_iter().take(12).map(|(_, doc)| doc).collect()
}

fn score_doc(doc: &ProjectDoc, query: Option<&str>) -> usize {
    let path = doc.rel_path.to_string_lossy().to_ascii_lowercase();
    let mut score =
        if path.contains("readme") || path.contains("agents.md") || path.contains("claude.md") {
            10
        } else if path.ends_with(".md") {
            4
        } else {
            2
        };

    if let Some(query) = query {
        for token in query.to_ascii_lowercase().split_whitespace() {
            if path.contains(token) {
                score += 8;
            }
            score += doc
                .content
                .to_ascii_lowercase()
                .matches(token)
                .count()
                .min(6);
        }
    }
    score
}

fn render_index(project_root: &Path, selected: &[&ProjectDoc], query: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str("# Openeral Memory\n\n");
    out.push_str(&format!("Project root: `{}`\n\n", project_root.display()));
    if let Some(query) = query {
        out.push_str(&format!("Focus query: `{query}`\n\n"));
    }
    out.push_str("## Files\n\n");
    out.push_str("- `project-context.md` - summarized project context selected from repository docs and config.\n");
    out.push_str("\n## Sources\n\n");
    for doc in selected {
        out.push_str(&format!("- `{}`\n", doc.rel_path.display()));
    }
    out
}

fn render_context_file(
    project_root: &Path,
    selected: &[&ProjectDoc],
    query: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("# Project Context\n\n");
    out.push_str(&format!("Project root: `{}`\n\n", project_root.display()));
    if let Some(query) = query {
        out.push_str(&format!("Focus query: `{query}`\n\n"));
    }
    for doc in selected {
        out.push_str(&format!("## `{}`\n\n", doc.rel_path.display()));
        write_excerpt(&mut out, &doc.content);
        out.push('\n');
    }
    out
}

fn write_excerpt(out: &mut String, content: &str) {
    let mut written = 0usize;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        out.push_str(trimmed);
        out.push('\n');
        written += 1;
        if written >= 80 {
            break;
        }
    }
}

fn backup_existing_memory(memory_dir: &Path) -> Result<(), FsError> {
    if !memory_dir.exists() || !has_markdown(memory_dir)? {
        return Ok(());
    }
    let stamp = chrono::Utc::now().to_rfc3339().replace([':', '.'], "-");
    let backup_dir = memory_dir
        .parent()
        .unwrap_or(memory_dir)
        .join(".openeral-memory-backups")
        .join(stamp);
    fs::create_dir_all(&backup_dir)?;
    for entry in fs::read_dir(memory_dir)? {
        let entry = entry?;
        if entry.path().extension() == Some(OsStr::new("md")) {
            fs::copy(entry.path(), backup_dir.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn has_markdown(dir: &Path) -> Result<bool, FsError> {
    for entry in fs::read_dir(dir)? {
        if entry?.path().extension() == Some(OsStr::new("md")) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn remove_existing_memory_markdown(memory_dir: &Path) -> Result<(), FsError> {
    if !memory_dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(memory_dir)? {
        let entry = entry?;
        if entry.path().extension() == Some(OsStr::new("md")) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_uses_claude_project_path_shape() {
        assert_eq!(slugify_project_path(Path::new("/work/app")), "-work-app");
    }

    #[test]
    fn skips_large_generated_dirs() {
        assert!(should_skip_dir(OsStr::new("node_modules")));
        assert!(should_skip_dir(OsStr::new(".git")));
        assert!(!should_skip_dir(OsStr::new("docs")));
    }
}
