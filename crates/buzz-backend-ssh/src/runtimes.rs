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
    /// CLI flag carrying `model`, for runtimes that take it as an argument
    /// rather than an env var.
    ///
    /// Desktop can only deliver model two ways: an env var, or its config
    /// bridge writing the runtime's own config file. The latter is inherently
    /// local — it edits files in the Desktop user's home — so a remote agent
    /// would silently ignore the model chosen in the UI. A CLI flag is the one
    /// channel that survives the host boundary.
    pub model_arg: Option<&'static str>,
    /// CLI flag carrying `provider`, same rationale as [`Self::model_arg`].
    pub provider_arg: Option<&'static str>,
    /// Whether the flags above must precede the subcommand in [`Self::args`].
    /// argparse-style CLIs reject top-level options placed after a subcommand.
    pub args_before_subcommand: bool,
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
        model_arg: None,
        provider_arg: None,
        args_before_subcommand: false,
    },
    RemoteRuntime {
        id: "codex",
        command: "codex-acp",
        args: &[],
        label: "Codex (codex-acp)",
        model_env: None,
        provider_env: None,
        model_arg: None,
        provider_arg: None,
        args_before_subcommand: false,
    },
    RemoteRuntime {
        id: "goose",
        command: "goose",
        args: &["acp"],
        label: "Goose (goose acp)",
        model_env: Some("GOOSE_MODEL"),
        provider_env: Some("GOOSE_PROVIDER"),
        model_arg: None,
        provider_arg: None,
        args_before_subcommand: false,
    },
    RemoteRuntime {
        id: "buzz-agent",
        command: "buzz-agent",
        args: &[],
        label: "Buzz Agent",
        model_env: Some("BUZZ_AGENT_MODEL"),
        provider_env: Some("BUZZ_AGENT_PROVIDER"),
        model_arg: None,
        provider_arg: None,
        args_before_subcommand: false,
    },
    RemoteRuntime {
        id: "hermes",
        command: "hermes",
        args: &["acp", "--accept-hooks"],
        label: "Hermes Agent (hermes acp)",
        // Hermes exposes no documented model env var; it takes top-level
        // `-m` / `--provider` flags, which must precede the `acp` subcommand.
        model_env: None,
        provider_env: None,
        model_arg: Some("-m"),
        provider_arg: Some("--provider"),
        args_before_subcommand: true,
    },
];

impl RemoteRuntime {
    /// Build the argument vector, injecting model/provider flags for runtimes
    /// that take them on the command line.
    ///
    /// Placement matters: argparse-style CLIs (hermes) treat `-m` as a
    /// top-level option and reject it after the `acp` subcommand.
    pub fn build_args(&self, model: Option<&str>, provider: Option<&str>) -> Vec<String> {
        let mut flags: Vec<String> = Vec::new();
        for (flag, value) in [(self.model_arg, model), (self.provider_arg, provider)] {
            if let (Some(flag), Some(value)) = (flag, value) {
                flags.push(flag.to_string());
                flags.push(value.to_string());
            }
        }
        let base = self.args.iter().map(|s| (*s).to_string());
        if self.args_before_subcommand {
            flags.into_iter().chain(base).collect()
        } else {
            base.chain(flags).collect()
        }
    }
}

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
    fn hermes_takes_model_as_a_flag_before_its_subcommand() {
        let hermes = by_id("hermes").expect("hermes present");
        let args = hermes.build_args(Some("gpt-5"), Some("openai"));
        assert_eq!(
            args,
            vec![
                "-m",
                "gpt-5",
                "--provider",
                "openai",
                "acp",
                "--accept-hooks"
            ],
            "argparse rejects top-level options placed after the subcommand"
        );
        // No model chosen: base args only.
        assert_eq!(hermes.build_args(None, None), vec!["acp", "--accept-hooks"]);
    }

    #[test]
    fn env_var_runtimes_do_not_grow_cli_flags() {
        let goose = by_id("goose").expect("goose present");
        assert_eq!(goose.build_args(Some("m"), Some("p")), vec!["acp"]);
    }

    #[test]
    fn hermes_accepts_hooks_for_headless_operation() {
        // Regression guard: dropping this flag makes hermes hang without a TTY.
        let hermes = by_id("hermes").expect("hermes present");
        assert!(hermes.args.contains(&"--accept-hooks"));
    }
}
