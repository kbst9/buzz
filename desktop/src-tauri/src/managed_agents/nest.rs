//! Buzz Nest — persistent agent workspace at `~/.buzz`.
//!
//! The scaffold itself (directories, AGENTS.md template, buzz-cli skill,
//! version-gated refresh) lives in the shared `buzz-nest` crate so the
//! `buzz-acp` harness seeds the identical workspace on standalone hosts.
//! This module keeps the desktop-only parts: nest path selection
//! (prod vs dev build), the bundled-CLI symlink, and the dynamic
//! AGENTS.md managed section rendered from desktop-managed agent records.

use super::{load_managed_agents, load_personas, AgentDefinition, ManagedAgentRecord};
#[cfg(test)]
use super::{BackendKind, RespondTo};
use crate::app_state::AppState;
use crate::relay::relay_ws_url_with_override;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use crate::util::create_symlink;

// Shared scaffold implementation — re-exported so existing
// `managed_agents::nest::*` / `pub use nest::*` consumers keep resolving.
pub use buzz_nest_pkg::{ensure_nest_at, upsert_managed_section, AGENTS_MD};

/// Nest directory name for production builds.
const NEST_DIR_PROD: &str = buzz_nest_pkg::NEST_DIR_NAME;

/// Nest directory name for dev builds. Dev builds (those whose Tauri app-data
/// directory name starts with `"xyz.block.buzz.app.dev"`) use a separate nest
/// so that the DMG and dev-build instances don't clobber each other's
/// `.repos-dir` dotfile and `REPOS` symlink.
const NEST_DIR_DEV: &str = buzz_nest_pkg::NEST_DIR_NAME_DEV;

/// Process-lifetime nest directory. Initialized once at startup via
/// [`init_nest_dir`] before any call to [`nest_dir`].
///
/// `None` inside the `OnceLock` means "home dir was unresolvable at init time".
/// The outer `None` from `OnceLock::get` means "not initialized yet" —
/// [`nest_dir`] falls back to the prod path in that case, ensuring test code
/// that never calls [`init_nest_dir`] still works.
static NEST_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Initialize the process-lifetime nest directory.
///
/// Must be called once at app startup (before any call to [`nest_dir`] that
/// may result in a filesystem operation). Subsequent calls are no-ops — the
/// `OnceLock` is set exactly once.
///
/// `is_dev` should be `true` when the running binary is a dev build — i.e.
/// when the Tauri app-data directory name starts with `"xyz.block.buzz.app.dev"`.
/// Pass `false` for production (signed DMG) builds.
pub fn init_nest_dir(is_dev: bool) {
    let suffix = if is_dev { NEST_DIR_DEV } else { NEST_DIR_PROD };
    let path = dirs::home_dir().map(|h| h.join(suffix));
    // set() is a no-op when already initialized, which is correct: only the
    // first call (at boot, before any filesystem work) should win.
    let _ = NEST_DIR.set(path);
}

/// Returns the nest root path (`~/.buzz` for prod, `~/.buzz-dev` for dev),
/// or `None` if the home directory cannot be resolved.
///
/// If [`init_nest_dir`] has not been called yet (e.g. in unit tests), falls
/// back to the production path `~/.buzz`.
pub fn nest_dir() -> Option<PathBuf> {
    match NEST_DIR.get() {
        Some(path) => path.clone(),
        // Not yet initialized — fall back to prod path. Covers test code.
        None => dirs::home_dir().map(|h| h.join(NEST_DIR_PROD)),
    }
}

/// Creates the Buzz nest at `~/.buzz` if it doesn't already exist.
///
/// Delegates to [`ensure_nest_at`] (shared `buzz-nest` crate) with the
/// resolved nest directory, then layers the desktop's configurable `REPOS`
/// provisioning on top ([`super::repos::ensure_repos_setup_default`]).
/// Returns an error string if the home directory cannot be resolved.
pub fn ensure_nest() -> Result<(), String> {
    let root = nest_dir().ok_or("cannot resolve home directory for nest")?;
    ensure_nest_at(&root)?;
    // The shared crate lands the minimal REPOS default (real dir, symlink
    // untouched); the desktop's own provisioning re-applies the same default
    // and stays the sole authority over configured `repos_dir` symlinks.
    super::repos::ensure_repos_setup_default(&root)
}

/// Returns the `~/.local/bin` link name for the bundled CLI.
///
/// Dev builds (`is_dev = true`) use `"buzz-dev"` so that a running DMG and a
/// concurrent dev build each own a separate link and never clobber each other —
/// the same isolation that separates `~/.buzz` (prod) from `~/.buzz-dev` (dev).
pub fn cli_link_name(is_dev: bool) -> &'static str {
    if is_dev {
        "buzz-dev"
    } else {
        "buzz"
    }
}

/// Ensures `~/.local/bin/buzz` (prod) or `~/.local/bin/buzz-dev` (dev) is a
/// symlink to the bundled CLI binary.
///
/// The link name is split by `is_dev` so that an installed DMG and a
/// concurrently running dev build each maintain their own symlink and never
/// overwrite each other's target — the same isolation that separates the
/// `~/.buzz` and `~/.buzz-dev` nests (see [`NEST_DIR_DEV`]).
///
/// On every boot: replaces any existing symlink unconditionally (the `buzz` /
/// `buzz-dev` name is our namespace), creates a new one if absent, and leaves
/// regular files alone to avoid clobbering a user-compiled binary.
///
/// Non-fatal: callers should ignore errors — the symlink is a convenience
/// for human Terminal use; agents find the CLI via PATH augmentation.
#[cfg(unix)]
pub fn ensure_cli_symlink(exe_parent: &Path, is_dev: bool) -> Result<(), String> {
    let buzz_bin = exe_parent.join("buzz");
    if !buzz_bin.exists() {
        return Ok(()); // CLI not bundled (e.g., dev builds without sidecars).
    }

    let local_bin = dirs::home_dir()
        .ok_or("cannot resolve home directory")?
        .join(".local")
        .join("bin");
    fs::create_dir_all(&local_bin).map_err(|e| format!("create {}: {e}", local_bin.display()))?;

    let link = local_bin.join(cli_link_name(is_dev));
    match link.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            let _ = fs::remove_file(&link);
            create_symlink(&buzz_bin, &link)
                .map_err(|e| format!("symlink {}: {e}", link.display()))?;
        }
        Ok(_) => {
            // Regular file or directory — don't clobber.
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            create_symlink(&buzz_bin, &link)
                .map_err(|e| format!("symlink {}: {e}", link.display()))?;
        }
        Err(e) => {
            return Err(format!("stat {}: {e}", link.display()));
        }
    }

    Ok(())
}

/// No-op on non-Unix platforms — symlink management is macOS/Linux only.
#[cfg(not(unix))]
pub fn ensure_cli_symlink(_exe_parent: &Path, _is_dev: bool) -> Result<(), String> {
    Ok(())
}

fn escape_md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

pub fn render_dynamic_section(
    personas: &[AgentDefinition],
    agents: &[ManagedAgentRecord],
    relay_url: &str,
) -> String {
    let active_agents = if agents.is_empty() {
        "## Active Agents\n\n*(No agents deployed yet. Add agents in the Buzz desktop app.)*"
            .to_string()
    } else {
        let mut table =
            "## Active Agents\n\n| Name | Persona | How to address |\n|------|---------|----------------|"
                .to_string();
        for agent in agents {
            let role = agent
                .persona_id
                .as_deref()
                .and_then(|pid| personas.iter().find(|p| p.id == pid))
                .map(|p| p.display_name.as_str())
                .unwrap_or("—");
            let name = escape_md_cell(&agent.name);
            let role_escaped = escape_md_cell(role);
            table.push_str(&format!("\n| {name} | {role_escaped} | @{name} |"));
        }
        table
    };

    let relay_url = relay_url.replace(['\n', '\r'], "");
    format!("{active_agents}\n\n## Workspace\n- Relay: {relay_url}")
}

pub fn regenerate_nest_context(app: &AppHandle) -> Result<(), String> {
    let nest = nest_dir().ok_or("cannot resolve home directory for nest")?;
    let agents_md = nest.join("AGENTS.md");

    if !agents_md.exists() {
        return Ok(());
    }

    let personas = load_personas(app)?;
    let agents = load_managed_agents(app)?;
    let state = app.state::<AppState>();
    let relay_url = relay_ws_url_with_override(&state);
    let content = render_dynamic_section(&personas, &agents, &relay_url);
    upsert_managed_section(&agents_md, &content)
        .map_err(|e| format!("regenerate nest context: {e}"))?;

    Ok(())
}

/// Convenience wrapper: regenerates nest context, logging a warning on failure.
///
/// All call sites treat regeneration as fire-and-forget — agents run fine with
/// a stale AGENTS.md, so we warn and continue rather than propagating the error.
pub fn try_regenerate_nest(app: &AppHandle) {
    if let Err(error) = regenerate_nest_context(app) {
        eprintln!("buzz-desktop: nest context regeneration failed: {error}");
    }
}

#[cfg(test)]
mod tests;
