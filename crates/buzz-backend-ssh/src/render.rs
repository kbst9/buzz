//! Pure rendering: deploy payload → env file, prompt file, systemd unit.
//!
//! Everything here is side-effect free so the exact bytes that would land on the
//! remote host are unit-testable, and so `--dry-run` shows the real artefacts
//! rather than an approximation.

use std::collections::BTreeMap;

/// Directory holding per-agent env files. Mode `0700`, root-owned: these carry
/// the agent's nsec and its NIP-OA attestation.
pub const ENV_DIR: &str = "/etc/buzz-agents";

/// Directory holding per-agent system prompts.
///
/// Deliberately **not** under [`ENV_DIR`]: that directory is `0700 root`, and the
/// harness reads its prompt as the agent's own Unix user. systemd reads
/// `EnvironmentFile` as root, so a prompt placed alongside the secrets loads
/// fine for root and then fails at runtime with
/// `configuration error: failed to read file: Permission denied`.
pub const PROMPT_DIR: &str = "/usr/local/share/buzz-agents/prompts";

/// Absolute path to the harness on the remote host.
pub const BUZZ_ACP: &str = "/usr/local/bin/buzz-acp";

/// Fully resolved deployment, ready to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploySpec {
    /// Slugified agent name; the stable identity of every artefact.
    pub id: String,
    /// Display name from the payload, for the unit `Description`.
    pub name: String,
    /// Remote Unix user the harness runs as.
    pub user: String,
    /// `WorkingDirectory` for the harness (and therefore the agent's cwd).
    pub workdir: String,
    /// Unit name prefix, default `buzz-acp-`.
    pub unit_prefix: String,

    pub relay_url: String,
    pub private_key_nsec: String,
    /// NIP-OA owner attestation minted by Desktop.
    pub auth_tag: Option<String>,

    pub agent_command: String,
    pub agent_args: Vec<String>,
    pub system_prompt: Option<String>,

    pub idle_timeout_seconds: Option<u64>,
    pub max_turn_duration_seconds: Option<u64>,
    pub parallelism: Option<u32>,

    pub respond_to: Option<String>,
    pub respond_to_allowlist: Vec<String>,

    /// Merged global < persona < agent env vars, plus the runtime's structured
    /// model/provider when it has env vars for them.
    pub env_vars: BTreeMap<String, String>,
}

impl DeploySpec {
    pub fn unit_name(&self) -> String {
        format!("{}{}.service", self.unit_prefix, self.id)
    }
    pub fn env_path(&self) -> String {
        format!("{ENV_DIR}/{}.env", self.id)
    }
    pub fn prompt_path(&self) -> String {
        format!("{PROMPT_DIR}/{}.md", self.id)
    }
    pub fn unit_path(&self) -> String {
        format!("/etc/systemd/system/{}", self.unit_name())
    }
}

/// Slugify an agent name into an id safe for filenames and systemd unit names.
///
/// Stability matters: deploy is idempotent by contract (Desktop re-sends the same
/// payload to update in place, and there is no `undeploy` op), so the same agent
/// must always resolve to the same unit. Renaming an agent in Desktop therefore
/// produces a *new* unit and orphans the old one — documented in the README.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // suppress a leading dash
    for ch in name.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "agent".to_string()
    } else {
        out.truncate_at_char_boundary(48)
    }
}

trait TruncateAt {
    fn truncate_at_char_boundary(self, max: usize) -> String;
}
impl TruncateAt for String {
    fn truncate_at_char_boundary(mut self, max: usize) -> String {
        if self.len() > max {
            self.truncate(max);
            while self.ends_with('-') {
                self.pop();
            }
        }
        self
    }
}

/// Render one `KEY="value"` line for a systemd `EnvironmentFile`.
///
/// Values are always double-quoted and backslash/quote escaped. systemd applies
/// C-style escape processing inside double quotes, so an unescaped `\` in an
/// nsec-adjacent value would be silently mangled.
///
/// # Errors
/// Rejects newlines and control characters — a single env line cannot represent
/// them, and silently truncating an agent's private key is not an option.
pub fn systemd_env_line(key: &str, value: &str) -> Result<String, String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("invalid env var name: {key:?}"));
    }
    if value.chars().any(|c| c == '\n' || c == '\r') {
        return Err(format!(
            "env var {key} contains a newline; use a file-backed setting instead"
        ));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!("env var {key} contains a control character"));
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("{key}=\"{escaped}\""))
}

/// Render the per-agent `EnvironmentFile`.
pub fn render_env_file(spec: &DeploySpec) -> Result<String, String> {
    let mut lines = vec![
        "# Managed by buzz-backend-ssh. Rewritten on every deploy.".to_string(),
        format!("# agent: {}", spec.name),
    ];

    let mut push = |k: &str, v: &str| -> Result<(), String> {
        lines.push(systemd_env_line(k, v)?);
        Ok(())
    };

    push("BUZZ_PRIVATE_KEY", &spec.private_key_nsec)?;
    push("BUZZ_RELAY_URL", &spec.relay_url)?;
    if let Some(tag) = spec.auth_tag.as_deref().filter(|t| !t.is_empty()) {
        push("BUZZ_AUTH_TAG", tag)?;
    }
    push("BUZZ_ACP_AGENT_COMMAND", &spec.agent_command)?;
    // The harness splits this on commas, so an argument containing one would be
    // silently torn in half — reject it rather than launch a mangled command.
    if let Some(bad) = spec.agent_args.iter().find(|a| a.contains(',')) {
        return Err(format!(
            "agent argument {bad:?} contains a comma, which BUZZ_ACP_AGENT_ARGS uses as its separator"
        ));
    }
    push("BUZZ_ACP_AGENT_ARGS", &spec.agent_args.join(","))?;
    if spec.system_prompt.is_some() {
        push("BUZZ_ACP_SYSTEM_PROMPT_FILE", &spec.prompt_path())?;
    }
    if let Some(t) = spec.idle_timeout_seconds {
        push("BUZZ_ACP_IDLE_TIMEOUT", &t.to_string())?;
    }
    if let Some(t) = spec.max_turn_duration_seconds {
        push("BUZZ_ACP_MAX_TURN_DURATION", &t.to_string())?;
    }

    // Operator-supplied env last so it wins on collision — same precedence as
    // local spawn, where user env is applied after the Buzz-set floor.
    for (k, v) in &spec.env_vars {
        push(k, v)?;
    }

    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// Render the `ExecStart` flag list.
fn exec_start_flags(spec: &DeploySpec) -> String {
    let mut flags = String::new();
    if let Some(n) = spec.parallelism.filter(|n| *n > 0) {
        flags.push_str(&format!(" --agents {n}"));
    }
    if let Some(mode) = spec.respond_to.as_deref().filter(|m| !m.is_empty()) {
        flags.push_str(&format!(" --respond-to {mode}"));
        if mode == "allowlist" && !spec.respond_to_allowlist.is_empty() {
            flags.push_str(&format!(
                " --respond-to-allowlist {}",
                spec.respond_to_allowlist.join(",")
            ));
        }
    }
    flags
}

/// Render the systemd unit.
pub fn render_unit_file(spec: &DeploySpec) -> String {
    format!(
        "[Unit]\n\
         Description=Buzz agent {name} (deployed by buzz-backend-ssh)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         User={user}\n\
         Group={user}\n\
         WorkingDirectory={workdir}\n\
         EnvironmentFile={env_path}\n\
         Environment=HOME=/home/{user}\n\
         Environment=PATH=/home/{user}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n\
         ExecStart={buzz_acp}{flags}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         StandardOutput=journal\n\
         StandardError=journal\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        name = spec.name,
        user = spec.user,
        workdir = spec.workdir,
        env_path = spec.env_path(),
        buzz_acp = BUZZ_ACP,
        flags = exec_start_flags(spec),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> DeploySpec {
        DeploySpec {
            id: "claude".into(),
            name: "Claude".into(),
            user: "buzz-claude".into(),
            workdir: "/home/buzz-claude/workspace".into(),
            unit_prefix: "buzz-acp-".into(),
            relay_url: "wss://buzz.example.com".into(),
            private_key_nsec: "nsec1abc".into(),
            auth_tag: Some(r#"["auth","aa","","bb"]"#.into()),
            agent_command: "claude-agent-acp".into(),
            agent_args: vec![],
            system_prompt: Some("Be terse.".into()),
            idle_timeout_seconds: Some(900),
            max_turn_duration_seconds: Some(7200),
            parallelism: Some(2),
            respond_to: Some("allowlist".into()),
            respond_to_allowlist: vec!["aaaa".into(), "bbbb".into()],
            env_vars: BTreeMap::new(),
        }
    }

    #[test]
    fn slug_is_filesystem_and_unit_safe() {
        assert_eq!(slug("Claude"), "claude");
        assert_eq!(slug("Hermes GPT"), "hermes-gpt");
        assert_eq!(slug("  weird//name!! "), "weird-name");
        assert_eq!(slug(""), "agent");
        assert_eq!(slug("!!!"), "agent");
        assert!(!slug("trailing---").ends_with('-'));
        assert!(slug(&"x".repeat(200)).len() <= 48);
    }

    #[test]
    fn env_values_are_quoted_and_escaped() {
        assert_eq!(systemd_env_line("A", "b").unwrap(), r#"A="b""#);
        assert_eq!(
            systemd_env_line("A", r#"has "quote" and \slash"#).unwrap(),
            r#"A="has \"quote\" and \\slash""#
        );
    }

    #[test]
    fn env_rejects_unrepresentable_values() {
        assert!(systemd_env_line("A", "line1\nline2").is_err());
        assert!(systemd_env_line("A", "tab\there").is_err());
        assert!(systemd_env_line("bad-name", "v").is_err());
        assert!(systemd_env_line("", "v").is_err());
    }

    #[test]
    fn env_file_carries_identity_and_prompt_pointer() {
        let out = render_env_file(&spec()).unwrap();
        assert!(out.contains(r#"BUZZ_PRIVATE_KEY="nsec1abc""#));
        assert!(out.contains(r#"BUZZ_RELAY_URL="wss://buzz.example.com""#));
        assert!(out.contains(r#"BUZZ_AUTH_TAG="[\"auth\",\"aa\",\"\",\"bb\"]""#));
        assert!(out.contains(
            r#"BUZZ_ACP_SYSTEM_PROMPT_FILE="/usr/local/share/buzz-agents/prompts/claude.md""#
        ));
        assert!(out.contains(r#"BUZZ_ACP_IDLE_TIMEOUT="900""#));
    }

    #[test]
    fn comma_in_an_argument_is_rejected() {
        let mut s = spec();
        s.agent_args = vec!["-m".into(), "model,with,commas".into()];
        let err = render_env_file(&s).unwrap_err();
        assert!(err.contains("comma"), "got: {err}");
    }

    #[test]
    fn env_file_omits_prompt_pointer_when_no_prompt() {
        let mut s = spec();
        s.system_prompt = None;
        let out = render_env_file(&s).unwrap();
        assert!(!out.contains("BUZZ_ACP_SYSTEM_PROMPT_FILE"));
    }

    #[test]
    fn operator_env_wins_on_collision() {
        let mut s = spec();
        s.env_vars
            .insert("BUZZ_ACP_IDLE_TIMEOUT".into(), "60".into());
        let out = render_env_file(&s).unwrap();
        let first = out.find(r#"BUZZ_ACP_IDLE_TIMEOUT="900""#).unwrap();
        let second = out.find(r#"BUZZ_ACP_IDLE_TIMEOUT="60""#).unwrap();
        assert!(second > first, "operator override must come last");
    }

    #[test]
    fn unit_runs_as_the_target_user_and_reads_the_env_file() {
        let out = render_unit_file(&spec());
        assert!(out.contains("User=buzz-claude"));
        assert!(out.contains("EnvironmentFile=/etc/buzz-agents/claude.env"));
        assert!(out.contains("WorkingDirectory=/home/buzz-claude/workspace"));
        assert!(out.contains("--agents 2"));
        assert!(out.contains("--respond-to allowlist --respond-to-allowlist aaaa,bbbb"));
        assert!(out.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn allowlist_is_omitted_unless_mode_is_allowlist() {
        let mut s = spec();
        s.respond_to = Some("owner-only".into());
        let out = render_unit_file(&s);
        assert!(out.contains("--respond-to owner-only"));
        assert!(!out.contains("--respond-to-allowlist"));
    }

    #[test]
    fn prompt_dir_is_outside_the_secrets_dir() {
        // Regression guard for the 0700-traverse failure: the agent reads its
        // prompt as its own user and cannot enter ENV_DIR.
        assert!(!PROMPT_DIR.starts_with(ENV_DIR));
    }
}
