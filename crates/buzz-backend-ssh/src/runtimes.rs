//! Remote runtime table.
//!
//! Desktop resolves `agent_command`/`agent_args` from its **own** machine's
//! runtime catalog (`KnownAcpRuntime`), then ships them in the deploy payload.
//! That is wrong for a remote deploy whenever the two machines have different
//! runtimes installed — which is the normal case, and the reason this table
//! exists: the operator names the *remote* runtime in `provider_config`, and we
//! substitute the command before writing the unit.
//!
//! Keep the ids aligned with `KnownAcpRuntime.id` in the desktop crate so the
//! two vocabularies never drift.

/// A runtime that can be launched on the remote host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteRuntime {
    /// Matches `KnownAcpRuntime.id` in the desktop catalog.
    pub id: &'static str,
    /// Binary the harness spawns. Resolved on the remote host's PATH.
    pub command: &'static str,
    /// Comma-joined into `BUZZ_ACP_AGENT_ARGS`.
    pub args: &'static [&'static str],
    /// Shown in the config-field description so the operator knows what the
    /// id actually launches.
    pub label: &'static str,
    /// Env var carrying the structured `model` from the deploy payload, when the
    /// runtime has one. Mirrors `KnownAcpRuntime.model_env_var`; `None` where the
    /// desktop catalog also has none (claude is provider-locked, codex brings its
    /// own backend) or where the name is not established (hermes — configure it
    /// through the persona's env vars instead).
    pub model_env: Option<&'static str>,
    /// Env var carrying the structured `provider`. Mirrors
    /// `KnownAcpRuntime.provider_env_var`.
    pub provider_env: Option<&'static str>,
}

/// Runtimes this provider knows how to launch remotely.
///
/// `hermes` is not in the desktop catalog — it is reachable here precisely
/// because the provider, not Desktop, decides the remote command. `--accept-hooks`
/// is required for it: without a TTY the adapter otherwise blocks on an
/// unseen-shell-hook prompt.
pub const REMOTE_RUNTIMES: &[RemoteRuntime] = &[
    RemoteRuntime {
        id: "claude",
        command: "claude-agent-acp",
        args: &[],
        label: "Claude Code (claude-agent-acp)",
        model_env: None,
        provider_env: None,
    },
    RemoteRuntime {
        id: "codex",
        command: "codex-acp",
        args: &[],
        label: "Codex (codex-acp)",
        model_env: None,
        provider_env: None,
    },
    RemoteRuntime {
        id: "goose",
        command: "goose",
        args: &["acp"],
        label: "Goose (goose acp)",
        model_env: Some("GOOSE_MODEL"),
        provider_env: Some("GOOSE_PROVIDER"),
    },
    RemoteRuntime {
        id: "buzz-agent",
        command: "buzz-agent",
        args: &[],
        label: "Buzz Agent",
        model_env: Some("BUZZ_AGENT_MODEL"),
        provider_env: Some("BUZZ_AGENT_PROVIDER"),
    },
    RemoteRuntime {
        id: "hermes",
        command: "hermes",
        args: &["acp", "--accept-hooks"],
        label: "Hermes Agent (hermes acp)",
        model_env: None,
        provider_env: None,
    },
];

/// Look up a runtime by id.
pub fn by_id(id: &str) -> Option<&'static RemoteRuntime> {
    REMOTE_RUNTIMES.iter().find(|r| r.id == id)
}

/// Every known id, for error messages and schema descriptions.
pub fn all_ids() -> Vec<&'static str> {
    REMOTE_RUNTIMES.iter().map(|r| r.id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut ids = all_ids();
        ids.sort_unstable();
        let len = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), len, "duplicate runtime id in REMOTE_RUNTIMES");
    }

    #[test]
    fn lookup_round_trips() {
        for r in REMOTE_RUNTIMES {
            assert_eq!(by_id(r.id).map(|x| x.command), Some(r.command));
        }
        assert!(by_id("nope").is_none());
    }

    #[test]
    fn hermes_accepts_hooks_for_headless_operation() {
        // Regression guard: dropping this flag makes hermes hang without a TTY.
        let hermes = by_id("hermes").expect("hermes present");
        assert!(hermes.args.contains(&"--accept-hooks"));
    }
}
