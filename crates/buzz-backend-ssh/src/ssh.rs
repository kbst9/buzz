//! SSH transport: runtime probing and remote installation.
//!
//! Two rules govern everything here.
//!
//! 1. **Secrets never touch argv.** `/proc/<pid>/cmdline` is world-readable on
//!    Linux, so the agent's nsec and NIP-OA attestation are written into a shell
//!    script that is fed to `ssh` on **stdin**. Nothing sensitive appears in a
//!    process list on either end, nor in shell history.
//! 2. **One connection per operation.** Each `ssh` invocation costs a full
//!    handshake — several seconds when the host sits behind an access proxy — so
//!    probing and installing are each a single round trip.

use crate::render::DeploySpec;
use crate::runtimes::REMOTE_RUNTIMES;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

/// True when `BUZZ_BACKEND_SSH_DRY_RUN` is set to anything non-empty.
pub fn dry_run() -> bool {
    std::env::var("BUZZ_BACKEND_SSH_DRY_RUN")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false)
}

fn ssh_base(host: &str, connect_timeout: u64) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes") // never prompt; fail instead of hanging Desktop
        .arg("-o")
        .arg(format!("ConnectTimeout={connect_timeout}"))
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg(host);
    cmd
}

/// Run a script on the remote host by piping it to `bash -s` over stdin.
///
/// Returns stdout on success. On failure the error carries stderr, which Desktop
/// stores in the agent's `last_error` and renders in its runtime details.
pub fn run_script(host: &str, script: &str, timeout: Duration) -> Result<String, String> {
    let mut cmd = ssh_base(host, 10);
    cmd.arg("bash").arg("-s");
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run ssh: {e}"))?;

    child
        .stdin
        .take()
        .ok_or("ssh stdin unavailable")?
        .write_all(script.as_bytes())
        .map_err(|e| format!("failed writing script to ssh: {e}"))?;

    // `wait_with_output` has no timeout, so bound it here: Desktop gives deploy
    // 600s and info 10s, and a hung ssh must surface as our error rather than
    // as an opaque provider timeout.
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                return Err(format!("ssh to {host} timed out after {:?}", timeout));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("ssh wait failed: {e}")),
        }
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("ssh output failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("remote command failed on {host} ({})", out.status)
        } else {
            format!("remote command failed on {host}: {stderr}")
        })
    }
}

/// A runtime found on the remote host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundRuntime {
    pub id: String,
    pub command: String,
    pub path: String,
}

/// Build the probe script: for each known runtime, resolve its command on PATH
/// as the target user and print `id<TAB>path` when found.
fn probe_script(user: Option<&str>) -> String {
    let mut s = String::from("set -u\n");
    for rt in REMOTE_RUNTIMES {
        let inner = format!("command -v {} 2>/dev/null || true", rt.command);
        let line = match user {
            // `sh -lc` so the user's own login PATH applies — hermes lives in
            // ~/.local/bin, which a non-login shell would miss.
            Some(u) => format!("p=$(sudo -n -u {u} -H sh -lc '{inner}' 2>/dev/null || true)\n"),
            None => format!("p=$(sh -lc '{inner}' 2>/dev/null || true)\n"),
        };
        s.push_str(&line);
        s.push_str(&format!(
            "[ -n \"$p\" ] && printf '{}\\t%s\\n' \"$p\"\n",
            rt.id
        ));
    }
    s.push_str("exit 0\n");
    s
}

/// Probe the host for installed runtimes, using a short-lived cache.
///
/// Best effort by design: a probe failure degrades the Desktop form to free-text
/// fields rather than blocking agent creation.
pub fn probe_runtimes(
    host: &str,
    user: Option<&str>,
    cache_seconds: u64,
) -> Result<Vec<FoundRuntime>, String> {
    if let Some(cached) = read_cache(host, cache_seconds) {
        return Ok(cached);
    }
    // Tight budget: `op:info` must answer well inside Desktop's 10s timeout.
    let out = run_script(host, &probe_script(user), Duration::from_secs(7))?;
    let found = parse_probe_output(&out);
    write_cache(host, &found);
    Ok(found)
}

pub fn parse_probe_output(out: &str) -> Vec<FoundRuntime> {
    out.lines()
        .filter_map(|line| {
            let (id, path) = line.split_once('\t')?;
            let id = id.trim();
            let path = path.trim();
            if id.is_empty() || path.is_empty() {
                return None;
            }
            let rt = crate::runtimes::by_id(id)?;
            Some(FoundRuntime {
                id: id.to_string(),
                command: rt.command.to_string(),
                path: path.to_string(),
            })
        })
        .collect()
}

fn cache_file(host: &str) -> Option<std::path::PathBuf> {
    // Host aliases can contain path separators in principle; slugify.
    let safe = crate::render::slug(host);
    crate::config::cache_dir().map(|d| d.join(format!("{safe}.probe")))
}

fn read_cache(host: &str, cache_seconds: u64) -> Option<Vec<FoundRuntime>> {
    if cache_seconds == 0 {
        return None;
    }
    let path = cache_file(host)?;
    let meta = std::fs::metadata(&path).ok()?;
    let age = meta.modified().ok()?.elapsed().ok()?;
    if age > Duration::from_secs(cache_seconds) {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let found = parse_probe_output(&text);
    if found.is_empty() {
        None
    } else {
        Some(found)
    }
}

fn write_cache(host: &str, found: &[FoundRuntime]) {
    let (Some(path), Some(dir)) = (cache_file(host), crate::config::cache_dir()) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let body: String = found
        .iter()
        .map(|f| format!("{}\t{}\n", f.id, f.path))
        .collect();
    let _ = std::fs::write(path, body);
}

/// Heredoc delimiter that cannot collide with rendered content.
///
/// Quoted (`<<'EOF'`) so the remote shell performs no expansion — an nsec or a
/// prompt containing `$` or backticks is written verbatim.
fn delimiter(kind: &str, spec: &DeploySpec) -> String {
    format!(
        "BUZZ_{}_{}_EOF",
        kind,
        spec.id.to_uppercase().replace('-', "_")
    )
}

/// Render the full install script.
pub fn install_script(spec: &DeploySpec) -> Result<String, String> {
    let env_body = crate::render::render_env_file(spec)?;
    let unit_body = crate::render::render_unit_file(spec);
    let prompt_body = spec.system_prompt.clone().unwrap_or_default();

    let env_d = delimiter("ENV", spec);
    let unit_d = delimiter("UNIT", spec);
    let prompt_d = delimiter("PROMPT", spec);

    for (name, body, d) in [
        ("env file", &env_body, &env_d),
        ("unit file", &unit_body, &unit_d),
        ("system prompt", &prompt_body, &prompt_d),
    ] {
        if body.lines().any(|l| l.trim() == d.as_str()) {
            return Err(format!("{name} contains the heredoc delimiter {d}"));
        }
    }

    let unit = spec.unit_name();
    let mut s = String::new();
    s.push_str("set -euo pipefail\numask 077\n");

    // Preflight: refuse to install a unit that cannot start. Failing here gives
    // Desktop a precise `last_error` instead of a crash-looping service.
    s.push_str(&format!(
        "if ! id -u {user} >/dev/null 2>&1; then echo \"remote user '{user}' does not exist\" >&2; exit 1; fi\n\
         if ! command -v {acp} >/dev/null 2>&1; then echo \"{acp} not found on the remote host\" >&2; exit 1; fi\n\
         if ! sudo -n -u {user} -H sh -lc 'command -v {cmd}' >/dev/null 2>&1; then \
           echo \"runtime '{cmd}' is not on PATH for remote user '{user}'\" >&2; exit 1; fi\n",
        user = spec.user,
        acp = crate::render::BUZZ_ACP,
        cmd = spec.agent_command,
    ));

    s.push_str(&format!(
        "sudo -n install -d -m 0700 -o root -g root {env_dir}\n\
         sudo -n install -d -m 0755 -o root -g root {prompt_dir}\n\
         sudo -n install -d -m 0755 -o {user} -g {user} {workdir}\n",
        env_dir = crate::render::ENV_DIR,
        prompt_dir = crate::render::PROMPT_DIR,
        workdir = spec.workdir,
        user = spec.user,
    ));

    // Write to a temp file then move into place: an interrupted deploy must not
    // leave a half-written env file that would start an agent with no identity.
    s.push_str(&format!(
        "tmp=$(mktemp)\ncat > \"$tmp\" <<'{env_d}'\n{env_body}\n{env_d}\n\
         sudo -n install -m 0600 -o root -g root \"$tmp\" {env_path}\nrm -f \"$tmp\"\n",
        env_path = spec.env_path(),
    ));

    if spec.system_prompt.is_some() {
        s.push_str(&format!(
            "tmp=$(mktemp)\ncat > \"$tmp\" <<'{prompt_d}'\n{prompt_body}\n{prompt_d}\n\
             sudo -n install -m 0644 -o root -g root \"$tmp\" {prompt_path}\nrm -f \"$tmp\"\n",
            prompt_path = spec.prompt_path(),
        ));
    }

    s.push_str(&format!(
        "tmp=$(mktemp)\ncat > \"$tmp\" <<'{unit_d}'\n{unit_body}\n{unit_d}\n\
         sudo -n install -m 0644 -o root -g root \"$tmp\" {unit_path}\nrm -f \"$tmp\"\n",
        unit_path = spec.unit_path(),
    ));

    s.push_str(&format!(
        "sudo -n systemctl daemon-reload\n\
         sudo -n systemctl enable --now {unit} >/dev/null\n\
         for i in 1 2 3 4 5 6 7 8 9 10; do\n\
         \x20 state=$(sudo -n systemctl is-active {unit} || true)\n\
         \x20 [ \"$state\" = active ] && break\n\
         \x20 sleep 1\n\
         done\n\
         if [ \"$state\" != active ]; then\n\
         \x20 echo \"unit {unit} did not become active (state=$state)\" >&2\n\
         \x20 sudo -n journalctl -u {unit} -n 25 --no-pager >&2 || true\n\
         \x20 exit 1\n\
         fi\n\
         printf 'deployed\\t%s\\n' {unit}\n"
    ));
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn spec() -> DeploySpec {
        DeploySpec {
            id: "hermes-gpt".into(),
            name: "HermesGPT".into(),
            user: "hermesgpt".into(),
            workdir: "/home/hermesgpt/workspace".into(),
            unit_prefix: "buzz-acp-".into(),
            relay_url: "wss://r.example".into(),
            private_key_nsec: "nsec1xyz".into(),
            auth_tag: None,
            agent_command: "hermes".into(),
            agent_args: vec!["acp".into(), "--accept-hooks".into()],
            system_prompt: Some("Be useful.".into()),
            idle_timeout_seconds: None,
            max_turn_duration_seconds: None,
            parallelism: Some(1),
            respond_to: Some("owner-only".into()),
            respond_to_allowlist: vec![],
            env_vars: BTreeMap::new(),
        }
    }

    #[test]
    fn probe_output_parses_known_runtimes_only() {
        let out =
            "hermes\t/home/h/.local/bin/hermes\ncodex\t/usr/local/bin/codex-acp\nbogus\t/x\n\n";
        let found = parse_probe_output(out);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "hermes");
        assert_eq!(found[1].command, "codex-acp");
    }

    #[test]
    fn install_script_never_puts_secrets_in_argv() {
        let s = install_script(&spec()).unwrap();
        // The nsec must appear only inside a quoted heredoc body.
        assert!(s.contains("nsec1xyz"));
        for line in s.lines() {
            if line.contains("nsec1xyz") {
                assert!(
                    !line.starts_with("sudo") && !line.contains("ssh "),
                    "secret leaked onto a command line: {line}"
                );
            }
        }
    }

    #[test]
    fn install_script_preflights_user_runtime_and_harness() {
        let s = install_script(&spec()).unwrap();
        assert!(s.contains("id -u hermesgpt"));
        assert!(s.contains("command -v /usr/local/bin/buzz-acp"));
        assert!(s.contains("command -v hermes"));
    }

    #[test]
    fn install_script_verifies_the_unit_started() {
        let s = install_script(&spec()).unwrap();
        assert!(s.contains("systemctl enable --now buzz-acp-hermes-gpt.service"));
        assert!(s.contains("is-active buzz-acp-hermes-gpt.service"));
        assert!(s.contains("journalctl -u buzz-acp-hermes-gpt.service"));
    }

    #[test]
    fn install_script_uses_quoted_heredocs() {
        let s = install_script(&spec()).unwrap();
        // Quoted delimiter => no remote expansion of `$` inside secrets/prompts.
        assert!(s.contains("<<'BUZZ_ENV_HERMES_GPT_EOF'"));
    }

    #[test]
    fn delimiter_collision_is_rejected() {
        let mut sp = spec();
        sp.system_prompt = Some(format!("x\n{}\ny", delimiter("PROMPT", &sp)));
        assert!(install_script(&sp).is_err());
    }

    #[test]
    fn probe_script_uses_login_shell_for_user_paths() {
        let s = probe_script(Some("hermes"));
        assert!(s.contains("sudo -n -u hermes -H sh -lc"));
        let s = probe_script(None);
        assert!(!s.contains("sudo"));
    }
}
