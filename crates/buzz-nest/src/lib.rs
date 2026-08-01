//! Buzz Nest — the persistent agent workspace scaffold (default `~/.buzz`).
//!
//! One shared implementation of workspace seeding, consumed by every process
//! that provisions an agent working directory:
//!
//! - the **desktop app** creates the nest at boot so desktop-managed agents
//!   start oriented (and layers its own dynamic AGENTS.md section on top),
//! - the **`buzz-acp` harness** seeds the same scaffold at startup so
//!   standalone/connected agents on plain hosts get the identical contract.
//!
//! The scaffold is orientation (`AGENTS.md`), knowledge directories
//! (`RESEARCH/`, `PLANS/`, …), and the buzz-cli skill file. Static template
//! content in AGENTS.md (above the managed-section markers) and SKILL.md is
//! refreshed when the embedded template version changes; the managed section
//! and any user content below it are preserved.
//!
//! Everything here is deliberately plain-filesystem: no async, no relay, no
//! UI dependencies. Dynamic, community-scoped content does **not** belong in
//! seeded files — it is served by the relay and injected into prompts fresh
//! (see `docs/agent-orientation.md`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Directory name of the production nest under the user's home (`~/.buzz`).
pub const NEST_DIR_NAME: &str = ".buzz";

/// Directory name of the desktop dev-build nest (`~/.buzz-dev`). Dev desktop
/// builds use a separate nest so DMG and dev instances don't clobber each
/// other; harness-side resolution never picks this name itself — a dev
/// desktop spawn is recognized by the version marker in its cwd instead.
pub const NEST_DIR_NAME_DEV: &str = ".buzz-dev";

/// Subdirectories created inside the nest.
/// `REPOS` is intentionally absent: it may be a symlink to an external
/// repos dir (desktop-configurable), so it is provisioned by
/// [`ensure_repos_default`] with a never-clobber guard instead.
pub const NEST_DIRS: &[&str] = &[
    "GUIDES",
    "RESEARCH",
    "PLANS",
    "WORK_LOGS",
    "OUTBOX",
    ".scratch",
];

/// Default AGENTS.md content written on first init.
/// Fully static — no runtime interpolation, no secrets, no user paths.
pub const AGENTS_MD: &str = include_str!("nest_agents.md");

/// Default SKILL.md content for the buzz-cli skill.
/// Written to `<nest>/.agents/skills/buzz-cli/SKILL.md` on first init.
pub const BUZZ_CLI_SKILL_MD: &str = include_str!("nest_skill.md");

/// Template content version for AGENTS.md static content (above managed markers).
/// Bump this when changing `nest_agents.md` to trigger refresh on existing installs.
/// Version 1 is implicitly "before this mechanism existed" (no version file).
/// Version 5: seeder-neutral wording (desktop app or agent harness).
pub const NEST_AGENTS_VERSION: u32 = 5;

/// Template content version for SKILL.md.
/// Bump this when changing `nest_skill.md` to trigger refresh on existing installs.
pub const NEST_SKILL_VERSION: u32 = 5;

/// Name of the version-marker file the AGENTS.md refresh is gated on. Its
/// presence also identifies a directory as an existing nest (the harness uses
/// it to recognize a desktop-provisioned cwd).
pub const NEST_AGENTS_VERSION_FILE: &str = ".nest-agents-version";

/// Opening marker of the managed (regenerated) AGENTS.md section.
pub const BEGIN_MARKER: &str = "<!-- BEGIN BUZZ MANAGED";
/// Closing marker of the managed (regenerated) AGENTS.md section.
pub const END_MARKER: &str = "<!-- END BUZZ MANAGED -->";

/// Canonical skill directory path relative to the nest root.
pub const CANONICAL_SKILL_DIR: &str = ".agents/skills/buzz-cli";

/// Harness-specific skill discovery directories that receive symlinks to
/// [`CANONICAL_SKILL_DIR`]. The desktop's runtime registry declares the same
/// paths per runtime; a desktop-side test asserts the two stay in sync.
pub const KNOWN_SKILL_DIRS: &[&str] = &[".goose/skills", ".claude/skills", ".codex/skills"];

/// Returns the default nest root for this user: `~/.buzz`.
///
/// `None` if the home directory cannot be resolved (containers with unset
/// `$HOME`). Desktop dev builds use `~/.buzz-dev` instead — that choice is
/// desktop-local and never made here.
pub fn default_nest_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(NEST_DIR_NAME))
}

/// Creates a Buzz nest at the given `root` path.
///
/// - Creates the root directory and all subdirectories.
/// - Writes `AGENTS.md` only if it doesn't already exist.
/// - Writes `.agents/skills/buzz-cli/SKILL.md` only if it doesn't already exist.
/// - Creates harness-specific symlinks pointing to the canonical
///   `.agents/skills/buzz-cli` directory for each known provider.
/// - Sets 700 permissions on the root, all subdirectories, and the skill
///   directory tree (Unix).
///
/// Idempotent: safe to call on every launch, from multiple processes. Static
/// template content in AGENTS.md (above the managed-section markers) and
/// SKILL.md is refreshed when the embedded template version changes. The
/// managed section in AGENTS.md and any user content below it are preserved.
///
/// Rejects symlinks at the root path to prevent redirect attacks.
///
/// Errors are returned as strings; callers should log and continue rather
/// than aborting startup — an unseeded workspace is degraded, not fatal.
pub fn ensure_nest_at(root: &Path) -> Result<(), String> {
    // Reject symlinks — we want a real directory, not a redirect.
    // Platform-independent: symlink_metadata works on all OS.
    if root
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "{} is a symlink; refusing to use as nest root",
            root.display()
        ));
    }

    // Create root and all subdirectories. create_dir_all is idempotent —
    // it succeeds silently if the directory already exists.
    fs::create_dir_all(root).map_err(|e| format!("create {}: {e}", root.display()))?;

    for dir in NEST_DIRS {
        let path = root.join(dir);
        fs::create_dir_all(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
    }

    // REPOS is provisioned outside NEST_DIRS: it may be a symlink to an
    // externally configured repos dir, so setup must never clobber one.
    ensure_repos_default(root)?;

    // Write AGENTS.md only if it doesn't already exist.
    // Uses create_new (O_CREAT|O_EXCL) to atomically check-and-create,
    // closing the TOCTOU gap that exists() + write() would leave open.
    // Also guarantees we never clobber a user-edited file.
    let agents_md = root.join("AGENTS.md");
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&agents_md)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(AGENTS_MD.as_bytes())
                .map_err(|e| format!("write {}: {e}", agents_md.display()))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // File already exists — leave it alone (idempotent).
        }
        Err(e) => {
            return Err(format!("create {}: {e}", agents_md.display()));
        }
    }

    // Write buzz-cli skill to the harness-agnostic .agents path.
    // The first-init write uses the new canonical path; migration from
    // the old .claude path is handled in refresh_skill_md_if_stale.
    let agents_skill_dir = root.join(CANONICAL_SKILL_DIR);
    fs::create_dir_all(&agents_skill_dir)
        .map_err(|e| format!("create {}: {e}", agents_skill_dir.display()))?;

    let skill_md = agents_skill_dir.join("SKILL.md");
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&skill_md)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(BUZZ_CLI_SKILL_MD.as_bytes())
                .map_err(|e| format!("write {}: {e}", skill_md.display()))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => {
            return Err(format!("create {}: {e}", skill_md.display()));
        }
    }

    // Create harness-specific symlinks for all known providers.
    // Migration of the old .claude/skills/buzz-cli real dir is handled in
    // refresh_skill_md_if_stale; ensure_skill_symlinks skips paths that already exist.
    ensure_skill_symlinks(root)?;

    // Refresh static content if the embedded template version is newer.
    refresh_agents_md_if_stale(root)?;
    refresh_skill_md_if_stale(root)?;

    // Set owner-only permissions on root and all subdirectories.
    // Skip any path that is a symlink — chmod would affect the target.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o700);
        fs::set_permissions(root, perms.clone())
            .map_err(|e| format!("set permissions on {}: {e}", root.display()))?;
        for dir in NEST_DIRS {
            let path = root.join(dir);
            let is_symlink = path
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            if !is_symlink {
                fs::set_permissions(&path, perms.clone())
                    .map_err(|e| format!("set permissions on {}: {e}", path.display()))?;
            }
        }
        // REPOS is provisioned outside NEST_DIRS (it may be a symlink). Only
        // chmod it when it is a real directory — chmod on a symlink would
        // affect the external repos target.
        let repos_path = root.join("REPOS");
        let repos_is_symlink = repos_path
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if !repos_is_symlink {
            fs::set_permissions(&repos_path, perms.clone())
                .map_err(|e| format!("set permissions on {}: {e}", repos_path.display()))?;
        }
        // Skill directory trees inside root get 700.
        // Build the list from canonical path + all known provider skill dirs.
        let mut skill_perm_dirs = Vec::new();
        {
            let mut accumulated = std::path::PathBuf::new();
            for component in std::path::Path::new(CANONICAL_SKILL_DIR).components() {
                accumulated.push(component);
                skill_perm_dirs.push(root.join(&accumulated));
            }
        }
        for skill_dir in KNOWN_SKILL_DIRS {
            // Ensure every ancestor dir gets 700, not just the leaf.
            let mut accumulated = std::path::PathBuf::new();
            for component in std::path::Path::new(skill_dir).components() {
                accumulated.push(component);
                skill_perm_dirs.push(root.join(&accumulated));
            }
        }
        for dir in skill_perm_dirs {
            let is_symlink = dir
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            if !is_symlink {
                fs::set_permissions(&dir, perms.clone())
                    .map_err(|e| format!("set permissions on {}: {e}", dir.display()))?;
            }
        }
    }

    Ok(())
}

/// Provision `REPOS` with the default (real-directory) layout.
///
/// Leaves an existing symlink untouched — a configured external repos dir
/// (desktop `repos_dir` setting) is owned by the desktop's re-point logic,
/// and clearing it here would silently break that configuration. Otherwise
/// (absent, or already a real dir) `create_dir_all` lands the default.
fn ensure_repos_default(root: &Path) -> Result<(), String> {
    let repos_path = root.join("REPOS");
    let is_symlink = repos_path
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if is_symlink {
        return Ok(());
    }
    fs::create_dir_all(&repos_path).map_err(|e| format!("create {}: {e}", repos_path.display()))
}

/// Create a symlink at `link` pointing to `target` on Unix; no-op elsewhere.
#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// No-op on non-Unix platforms — the skill symlink layout is Unix-only.
#[cfg(not(unix))]
fn create_symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Create harness-specific skill symlinks for each known provider.
/// Idempotent: skips any path where `symlink_metadata` succeeds — real
/// directories, valid symlinks, and dangling symlinks are all left alone.
#[cfg(unix)]
fn ensure_skill_symlinks(root: &Path) -> Result<(), String> {
    for skill_dir in KNOWN_SKILL_DIRS {
        let parent = root.join(skill_dir);
        fs::create_dir_all(&parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        let link = parent.join("buzz-cli");
        if link.symlink_metadata().is_ok() {
            continue; // symlink or real path exists — skip
        }
        let depth = std::path::Path::new(skill_dir).components().count();
        let prefix = "../".repeat(depth);
        let target = format!("{prefix}{CANONICAL_SKILL_DIR}");
        create_symlink(std::path::Path::new(&target), &link)
            .map_err(|e| format!("symlink {} → {}: {e}", link.display(), target))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_skill_symlinks(_root: &Path) -> Result<(), String> {
    Ok(())
}

/// Read a version number from a file. Returns 0 if the file doesn't exist or can't be parsed.
fn read_version_file(path: &Path) -> u32 {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Refresh AGENTS.md static content if the template version has changed.
///
/// Preserves everything from the `<!-- BEGIN BUZZ MANAGED` marker onward
/// (the dynamic section managed by `upsert_managed_section`). Replaces
/// only the static template content above the marker.
fn refresh_agents_md_if_stale(root: &Path) -> Result<(), String> {
    let version_path = root.join(NEST_AGENTS_VERSION_FILE);
    if read_version_file(&version_path) >= NEST_AGENTS_VERSION {
        return Ok(());
    }

    let agents_md = root.join("AGENTS.md");
    let current =
        fs::read_to_string(&agents_md).map_err(|e| format!("read {}: {e}", agents_md.display()))?;

    let new_content = match find_marker_at_line_start(&current, BEGIN_MARKER) {
        Some(pos) => {
            // Find the start of the marker line (could be preceded by blank lines).
            let marker_line_start = current[..pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
            // Template content up to (but not including) the managed section,
            // then the existing managed section from the marker onward.
            let template_static = match AGENTS_MD.find(BEGIN_MARKER) {
                Some(tmpl_marker_pos) => {
                    let tmpl_line_start = AGENTS_MD[..tmpl_marker_pos]
                        .rfind('\n')
                        .map(|p| p + 1)
                        .unwrap_or(0);
                    &AGENTS_MD[..tmpl_line_start]
                }
                None => AGENTS_MD,
            };
            format!("{}{}", template_static, &current[marker_line_start..])
        }
        None => {
            // No managed section found — write full template.
            AGENTS_MD.to_string()
        }
    };

    // Atomic write via temp file.
    let parent = agents_md.parent().ok_or("AGENTS.md has no parent dir")?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("tempfile in {}: {e}", parent.display()))?;
    {
        use std::io::Write;
        tmp.write_all(new_content.as_bytes())
            .map_err(|e| format!("write tempfile: {e}"))?;
    }
    tmp.persist(&agents_md)
        .map_err(|e| format!("persist {}: {e}", agents_md.display()))?;

    fs::write(&version_path, format!("{NEST_AGENTS_VERSION}\n"))
        .map_err(|e| format!("write {}: {e}", version_path.display()))?;

    Ok(())
}

/// Refresh SKILL.md if the template version has changed.
///
/// SKILL.md has no user-editable sections — it is fully overwritten on version bump.
fn refresh_skill_md_if_stale(root: &Path) -> Result<(), String> {
    let agents_skill_dir = root.join(CANONICAL_SKILL_DIR);
    let version_path = agents_skill_dir.join(".skill-version");
    if read_version_file(&version_path) >= NEST_SKILL_VERSION {
        return Ok(());
    }

    // Migration: if .claude/skills/buzz-cli exists as a real directory
    // (pre-migration install), copy user's SKILL.md to the new location
    // then remove the old directory so we can replace it with a symlink.
    let old_skill_dir = root.join(".claude/skills/buzz-cli");
    let old_is_real_dir = old_skill_dir
        .symlink_metadata()
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false);

    let skill_content = if old_is_real_dir {
        // Preserve user-edited content during migration.
        fs::read_to_string(old_skill_dir.join("SKILL.md"))
            .unwrap_or_else(|_| BUZZ_CLI_SKILL_MD.to_string())
    } else {
        BUZZ_CLI_SKILL_MD.to_string()
    };

    // Ensure the canonical .agents skill directory exists.
    fs::create_dir_all(&agents_skill_dir)
        .map_err(|e| format!("create {}: {e}", agents_skill_dir.display()))?;

    // Atomic write via temp file.
    let skill_md = agents_skill_dir.join("SKILL.md");
    let mut tmp = tempfile::NamedTempFile::new_in(&agents_skill_dir)
        .map_err(|e| format!("tempfile in {}: {e}", agents_skill_dir.display()))?;
    {
        use std::io::Write;
        tmp.write_all(skill_content.as_bytes())
            .map_err(|e| format!("write tempfile: {e}"))?;
    }
    tmp.persist(&skill_md)
        .map_err(|e| format!("persist {}: {e}", skill_md.display()))?;

    // Replace old real directory with a symlink.
    if old_is_real_dir {
        fs::remove_dir_all(&old_skill_dir)
            .map_err(|e| format!("remove {}: {e}", old_skill_dir.display()))?;
    }

    // Create/replace the .claude/skills/buzz-cli symlink.
    #[cfg(unix)]
    {
        let claude_skills_dir = root.join(".claude/skills");
        fs::create_dir_all(&claude_skills_dir)
            .map_err(|e| format!("create {}: {e}", claude_skills_dir.display()))?;
        let symlink_path = root.join(".claude/skills/buzz-cli");
        // Remove any stale symlink before (re)creating.
        let symlink_exists = symlink_path
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if symlink_exists {
            fs::remove_file(&symlink_path)
                .map_err(|e| format!("remove symlink {}: {e}", symlink_path.display()))?;
        }
        create_symlink(
            std::path::Path::new("../../.agents/skills/buzz-cli"),
            &symlink_path,
        )
        .map_err(|e| format!("symlink {}: {e}", symlink_path.display()))?;
    }

    fs::write(&version_path, format!("{NEST_SKILL_VERSION}\n"))
        .map_err(|e| format!("write {}: {e}", version_path.display()))?;

    Ok(())
}

/// Find a marker that appears at the start of a line (position 0 or preceded by `\n`).
fn find_marker_at_line_start(content: &str, marker: &str) -> Option<usize> {
    let mut search_from = 0;
    while let Some(pos) = content[search_from..].find(marker) {
        let abs_pos = search_from + pos;
        if abs_pos == 0 || content.as_bytes()[abs_pos - 1] == b'\n' {
            return Some(abs_pos);
        }
        search_from = abs_pos + 1;
    }
    None
}

/// Find the first valid ordered BEGIN/END marker pair, both at line starts.
/// Returns `(begin_line_start, after_end)` byte offsets for slicing.
fn find_managed_markers(content: &str) -> Option<(usize, usize)> {
    let begin_pos = find_marker_at_line_start(content, BEGIN_MARKER)?;
    let begin_line_start = content[..begin_pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let end_pos =
        find_marker_at_line_start(&content[begin_pos..], END_MARKER).map(|p| p + begin_pos)?;
    let end_of_end = end_pos + END_MARKER.len();
    let after_end = if content[end_of_end..].starts_with('\n') {
        end_of_end + 1
    } else {
        end_of_end
    };
    Some((begin_line_start, after_end))
}

/// Remove an orphan BEGIN marker line (one with no matching END after it).
fn strip_orphan_begin_marker(content: &str) -> String {
    if let Some(pos) = find_marker_at_line_start(content, BEGIN_MARKER) {
        let line_start = content[..pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
        let line_end = content[pos..]
            .find('\n')
            .map(|p| pos + p + 1)
            .unwrap_or(content.len());
        format!(
            "{}{}",
            &content[..line_start],
            content[line_end..]
                .strip_prefix('\n')
                .unwrap_or(&content[line_end..])
        )
    } else {
        content.to_string()
    }
}

/// Replace (or append) the managed section of a nest file with
/// `new_section_content`, preserving everything outside the markers.
///
/// The write is atomic (temp file + rename) and skipped entirely when the
/// resulting content is unchanged, so callers may invoke it on every launch
/// without churning mtimes.
pub fn upsert_managed_section(file_path: &Path, new_section_content: &str) -> io::Result<()> {
    let current = fs::read_to_string(file_path)?;

    let replacement = format!(
        "{BEGIN_MARKER} — regenerated automatically, do not edit below -->\n{new_section_content}\n{END_MARKER}\n"
    );

    let new_content = match find_managed_markers(&current) {
        Some((begin_line_start, after_end)) => {
            format!(
                "{}{}{}",
                &current[..begin_line_start],
                replacement,
                &current[after_end..]
            )
        }
        None => {
            let cleaned = strip_orphan_begin_marker(&current);
            format!("{}\n\n{}", cleaned.trim_end_matches('\n'), replacement)
        }
    };

    // Skip write when content is unchanged — avoids bumping mtime on every launch.
    if new_content == current {
        return Ok(());
    }

    let parent = file_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "file path has no parent directory",
        )
    })?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    {
        use std::io::Write;
        tmp.write_all(new_content.as_bytes())?;
    }
    tmp.persist(file_path).map_err(|e| e.error)?;

    Ok(())
}

#[cfg(test)]
mod tests;
