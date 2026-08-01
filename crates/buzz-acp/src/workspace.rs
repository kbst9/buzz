//! Harness-side agent workspace: resolve, seed, and enter the Buzz Nest.
//!
//! Desktop-managed agents historically got their workspace from the desktop
//! app, which builds the nest at `~/.buzz` and spawns the harness inside it.
//! Standalone agents have no desktop — without this module they start in
//! whatever cwd their unit file left them (systemd default: `/`) while the
//! base prompt describes a workspace that was never created.
//!
//! At startup the harness therefore resolves a workspace directory, seeds it
//! with the shared scaffold (`buzz_nest::ensure_nest_at` — the same
//! implementation the desktop calls), and makes it the process working
//! directory so sessions and the `[Workspace]` prompt section anchor there.
//!
//! Resolution order:
//! 1. an explicit `--workspace` / `BUZZ_ACP_WORKSPACE` path,
//! 2. the current directory, when it already contains a nest (recognized by
//!    the version marker) — this is the desktop-spawn case, including the
//!    dev-build `~/.buzz-dev` nest, and stays byte-for-byte compatible,
//! 3. the default `~/.buzz`.
//!
//! Rule 2/3 ordering means the harness never sprays scaffold into an
//! arbitrary unmarked cwd: unless the operator names a path, seeding only
//! ever writes to an existing nest or to `~/.buzz`.
//!
//! Every failure here is a warning, never fatal — an unseeded workspace is a
//! degraded start, not a reason to keep the agent offline.

use std::path::{Path, PathBuf};

/// Resolve the workspace directory from an explicit override, the current
/// directory, and the home-derived default.
///
/// Pure function — all inputs injected — so the precedence rules are unit
/// testable without touching process state:
/// - `configured` wins outright when present;
/// - else `cwd` when it already contains [`buzz_nest::NEST_AGENTS_VERSION_FILE`];
/// - else `default_nest` (`~/.buzz`), which may be `None` when no home
///   directory is resolvable — in that case there is nothing to seed.
fn resolve_workspace(
    configured: Option<&str>,
    cwd: Option<&Path>,
    default_nest: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = configured {
        return Some(PathBuf::from(path));
    }
    if let Some(cwd) = cwd {
        if cwd.join(buzz_nest::NEST_AGENTS_VERSION_FILE).is_file() {
            return Some(cwd.to_path_buf());
        }
    }
    default_nest
}

/// Resolve, seed, and enter the agent workspace. Called once at startup,
/// before the agent pool (or setup listener) starts.
///
/// Never fails the caller: every error path logs a warning and returns, and
/// the process keeps its current working directory. Sessions then behave
/// exactly as before this mechanism existed.
pub(crate) fn prepare(configured: Option<&str>) {
    let cwd = std::env::current_dir().ok();
    let Some(workspace) =
        resolve_workspace(configured, cwd.as_deref(), buzz_nest::default_nest_dir())
    else {
        tracing::warn!(
            "workspace not seeded: no --workspace/BUZZ_ACP_WORKSPACE set and no home \
             directory resolvable; agents keep the inherited working directory"
        );
        return;
    };

    if let Err(error) = buzz_nest::ensure_nest_at(&workspace) {
        tracing::warn!(
            workspace = %workspace.display(),
            "workspace not seeded: {error}; agents keep the inherited working directory"
        );
        return;
    }

    // Only chdir after a successful seed: entering an unseeded directory
    // would anchor the [Workspace] prompt section to a broken layout.
    if let Err(error) = std::env::set_current_dir(&workspace) {
        tracing::warn!(
            workspace = %workspace.display(),
            "workspace seeded but could not chdir into it: {error}"
        );
        return;
    }

    tracing::info!(workspace = %workspace.display(), "workspace seeded");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that touch the process-global working directory.
    static CWD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn explicit_override_wins_over_marked_cwd_and_default() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("marked-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(cwd.join(buzz_nest::NEST_AGENTS_VERSION_FILE), "4\n").unwrap();

        let resolved = resolve_workspace(
            Some("/explicit/workspace"),
            Some(&cwd),
            Some(PathBuf::from("/home/agent/.buzz")),
        );
        assert_eq!(resolved, Some(PathBuf::from("/explicit/workspace")));
    }

    #[test]
    fn marked_cwd_wins_over_default() {
        // The desktop-spawn case: cwd is an existing nest (prod or dev) and
        // must be kept — falling through to ~/.buzz would abandon the
        // desktop's nest (and a dev build's ~/.buzz-dev).
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join(".buzz-dev");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(cwd.join(buzz_nest::NEST_AGENTS_VERSION_FILE), "4\n").unwrap();

        let resolved =
            resolve_workspace(None, Some(&cwd), Some(PathBuf::from("/home/agent/.buzz")));
        assert_eq!(resolved, Some(cwd));
    }

    #[test]
    fn unmarked_cwd_falls_through_to_default() {
        // A standalone unit (cwd=/) or a manual run from a source checkout:
        // never seed the unmarked cwd, go to ~/.buzz instead.
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_workspace(
            None,
            Some(tmp.path()),
            Some(PathBuf::from("/home/agent/.buzz")),
        );
        assert_eq!(resolved, Some(PathBuf::from("/home/agent/.buzz")));
    }

    #[test]
    fn no_home_and_no_marker_resolves_to_none() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_workspace(None, Some(tmp.path()), None);
        assert_eq!(resolved, None);
    }

    #[test]
    fn prepare_with_unwritable_root_is_nonfatal_and_keeps_cwd() {
        // Seeding into a read-only parent must warn and leave the process
        // where it was — never panic, never chdir.
        let tmp = tempfile::tempdir().unwrap();
        let readonly = tmp.path().join("readonly");
        std::fs::create_dir(&readonly).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&readonly, std::fs::Permissions::from_mode(0o500)).unwrap();

            let _cwd_guard = CWD_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let before = std::env::current_dir().unwrap();
            let target = readonly.join("nest");
            prepare(Some(target.to_str().unwrap()));
            assert_eq!(
                std::env::current_dir().unwrap(),
                before,
                "cwd must be unchanged after a failed seed"
            );
            assert!(!target.exists(), "no partial nest may appear");

            // Restore write bit so the tempdir can be cleaned up.
            std::fs::set_permissions(&readonly, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    #[test]
    fn prepare_seeds_and_enters_explicit_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("agent-ws");

        let _cwd_guard = CWD_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let before = std::env::current_dir().unwrap();
        prepare(Some(target.to_str().unwrap()));

        assert!(
            target.join("AGENTS.md").is_file(),
            "scaffold must be seeded"
        );
        assert!(
            target.join(buzz_nest::NEST_AGENTS_VERSION_FILE).is_file(),
            "version marker must be written"
        );
        let entered = std::env::current_dir().unwrap();
        assert_eq!(
            entered.canonicalize().unwrap(),
            target.canonicalize().unwrap(),
            "process must enter the seeded workspace"
        );

        // Restore the original cwd for sibling tests in this process.
        std::env::set_current_dir(before).unwrap();
    }
}
