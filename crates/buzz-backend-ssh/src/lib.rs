//! `buzz-backend-ssh` — a Buzz agent **backend provider**.
//!
//! Buzz Desktop discovers executables named `buzz-backend-*` on `PATH`, in its
//! own bundle directory, and in `~/.local/bin`. Each one becomes an entry in the
//! agent dialog's **"Run on"** selector, and Desktop delegates that agent's
//! deployment to it. The protocol is one JSON object on stdin, one on stdout,
//! per process invocation:
//!
//! * `{"op":"info"}` → `{ok, name, version, description, config_schema}`
//! * `{"op":"deploy", "agent":{…}, "provider_config":{…}}` → `{"agent_id":"…"}`
//!
//! This provider turns a deploy payload into a `buzz-acp` systemd unit on a
//! remote host reached over SSH, so agents are created and configured in Desktop
//! while executing on an always-on machine.
//!
//! ## Why a runtime override exists
//!
//! Desktop resolves `agent_command` from the runtime catalog of the machine
//! *running Desktop*, then ships it in the payload. On a laptop that typically
//! means only the bundled `buzz-agent` is fully available, while the server has
//! the adapters actually worth running. So `provider_config.runtime` names the
//! **remote** runtime and we substitute the command before writing the unit.

pub mod config;
pub mod render;
pub mod runtimes;
pub mod ssh;

use render::{slug, DeploySpec};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

pub const PROVIDER_NAME: &str = "ssh";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Dispatch one request. Unknown ops are an error, not a silent no-op.
pub fn handle(req: &Value) -> Result<Value, String> {
    match req.get("op").and_then(Value::as_str) {
        Some("info") => Ok(op_info()),
        Some("deploy") => op_deploy(
            req.get("agent").ok_or("deploy request missing `agent`")?,
            req.get("provider_config").unwrap_or(&Value::Null),
        ),
        Some(other) => Err(format!("unsupported op `{other}`")),
        None => Err("request missing `op`".to_string()),
    }
}

/// Answer `op:info` with a config schema, pre-filled from local config and — when
/// a default host is configured and reachable — from a live runtime probe.
///
/// Desktop renders provider config as plain text inputs and ignores JSON Schema
/// `enum`, so discovered runtimes are surfaced through `description` and
/// `default` rather than as a dropdown.
pub fn op_info() -> Value {
    config::write_example_if_missing();
    let cfg = config::load().unwrap_or_default();

    let mut runtime_desc = format!(
        "Runtime to launch on the remote host. Known: {}.",
        runtimes::all_ids().join(", ")
    );
    let mut user_desc =
        "Unix user the agent runs as. Give each agent its own unprivileged account.".to_string();
    let mut runtime_enum: Vec<String> = Vec::new();
    let mut user_enum: Vec<String> = Vec::new();
    let mut runtime_default = String::new();
    let mut user_default = cfg.default_user.clone().unwrap_or_default();
    let mut notes: Vec<String> = Vec::new();

    if let Some(host) = cfg.default_host.as_deref() {
        match ssh::probe_runtimes(host, &cfg.users, cfg.probe_cache_seconds()) {
            Ok(probe) if !probe.found.is_empty() => {
                runtime_enum = probe.runtime_ids();
                runtime_default = runtime_enum[0].clone();
                runtime_desc = format!("Detected on {host} — {}.", probe.summary());

                user_enum = probe.users();
                if user_default.is_empty() {
                    user_default = probe.login_user.clone().unwrap_or_default();
                }
                user_desc = format!(
                    "Unix user the agent runs as. Accounts on {host}: {}. \
                     Give each agent its own unprivileged account.",
                    user_enum.join(", ")
                );
            }
            Ok(_) => notes.push(format!("no known runtimes detected on {host}")),
            Err(e) => notes.push(format!("probe of {host} failed: {e}")),
        }
    } else {
        notes.push(
            "set `default_host` in ~/.config/buzz-backend-ssh/config.toml to pre-fill this form"
                .to_string(),
        );
    }

    let mut description =
        "Deploy the agent to a remote host over SSH as a buzz-acp systemd unit.".to_string();
    if !notes.is_empty() {
        description.push_str(&format!(" ({})", notes.join("; ")));
    }

    // Only advertise `enum` when detection actually produced choices; an empty
    // enum would render as a dropdown with nothing in it and no way to type.
    let mut runtime_prop = json!({
        "type": "string",
        "title": "Remote runtime",
        "description": runtime_desc,
        "default": runtime_default,
    });
    if !runtime_enum.is_empty() {
        runtime_prop["enum"] = json!(runtime_enum);
    }

    let mut user_prop = json!({
        "type": "string",
        "title": "Remote user",
        "description": user_desc,
        "default": user_default,
    });
    if !user_enum.is_empty() {
        user_prop["enum"] = json!(user_enum);
    }

    json!({
        "ok": true,
        "name": PROVIDER_NAME,
        "version": VERSION,
        "description": description,
        "config_schema": {
            "type": "object",
            "required": ["host", "user", "runtime"],
            "properties": {
                "host": {
                    "type": "string",
                    "title": "SSH host",
                    "description": "Alias from ~/.ssh/config. Authentication uses your SSH agent; credentials are never stored here.",
                    "default": cfg.default_host.clone().unwrap_or_default(),
                },
                "user": user_prop,
                "runtime": runtime_prop,
                "workdir": {
                    "type": "string",
                    "title": "Working directory",
                    "description": "Defaults to <workdir_base>/<agent-id>, or /home/<user>/buzz-agents/<agent-id>.",
                },
            }
        }
    })
}

/// Handle `op:deploy`: resolve, render, install, verify.
pub fn op_deploy(agent: &Value, provider_config: &Value) -> Result<Value, String> {
    let cfg = config::load()?;
    let (spec, host) = resolve(agent, provider_config, &cfg)?;
    let script = ssh::install_script(&spec)?;

    if ssh::dry_run() {
        eprintln!("--- host: {host}");
        eprintln!(
            "--- {} ---\n{}",
            spec.env_path(),
            render::render_env_file(&spec)?
        );
        eprintln!(
            "--- {} ---\n{}",
            spec.unit_path(),
            render::render_unit_file(&spec)
        );
        if let Some(p) = spec.system_prompt.as_deref() {
            eprintln!("--- {} ---\n{}", spec.prompt_path(), p);
        }
        eprintln!("--- install script ---\n{script}");
        return Ok(json!({ "agent_id": spec.unit_name(), "dry_run": true }));
    }

    // Desktop allows 600s for deploy; stay inside it so a stall surfaces as our
    // error with context rather than an opaque provider timeout.
    ssh::run_script(&host, &script, Duration::from_secs(540))?;
    Ok(json!({ "agent_id": spec.unit_name() }))
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Resolve payload + provider config into a [`DeploySpec`] and target host.
///
/// Pure: no SSH, no filesystem. This is where every defaulting rule lives, so
/// the rules are testable without a remote host.
pub fn resolve(
    agent: &Value,
    provider_config: &Value,
    cfg: &config::Config,
) -> Result<(DeploySpec, String), String> {
    let name = str_field(agent, "name").ok_or("agent payload missing `name`")?;
    let id = slug(&name);

    let host = str_field(provider_config, "host")
        .or_else(|| cfg.default_host.clone())
        .ok_or("`host` is required (set it in the Run-on form or as default_host)")?;
    let user = str_field(provider_config, "user")
        .or_else(|| cfg.default_user.clone())
        .ok_or("`user` is required: the Unix user the agent runs as on the remote host")?;

    let relay_url = str_field(agent, "relay_url").ok_or("agent payload missing `relay_url`")?;
    // Mirrors Desktop's own fail-closed guard: an agent with no identity would
    // start, fail relay auth, and crash-loop.
    let private_key_nsec =
        str_field(agent, "private_key_nsec").ok_or("agent payload has no private key")?;

    let workdir =
        str_field(provider_config, "workdir").unwrap_or_else(|| match &cfg.workdir_base {
            Some(base) => format!("{}/{}", base.trim_end_matches('/'), id),
            None => format!("/home/{user}/buzz-agents/{id}"),
        });

    // Runtime override: prefer the operator's remote choice, else trust the
    // payload's command (which came from Desktop's local catalog).
    let payload_command = str_field(agent, "agent_command");
    let (agent_command, agent_args, runtime) = match str_field(provider_config, "runtime") {
        Some(rt_id) => {
            let rt = runtimes::by_id(&rt_id).ok_or_else(|| {
                format!(
                    "unknown runtime `{rt_id}`; known runtimes: {}",
                    runtimes::all_ids().join(", ")
                )
            })?;
            (
                rt.command.to_string(),
                rt.args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                Some(rt),
            )
        }
        None => {
            let cmd = payload_command
                .clone()
                .ok_or("no `runtime` in provider config and no `agent_command` in the payload")?;
            let args = agent
                .get("agent_args")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let rt = runtimes::REMOTE_RUNTIMES.iter().find(|r| r.command == cmd);
            (cmd, args, rt)
        }
    };

    let mut env_vars: BTreeMap<String, String> = agent
        .get("env_vars")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    // Project structured model/provider onto the runtime's env vars, matching
    // what local spawn does. Operator env already in the map wins.
    if let Some(rt) = runtime {
        for (field, var) in [("model", rt.model_env), ("provider", rt.provider_env)] {
            if let (Some(value), Some(var)) = (str_field(agent, field), var) {
                env_vars.entry(var.to_string()).or_insert(value);
            }
        }
    }

    let spec = DeploySpec {
        id,
        name,
        user,
        workdir,
        unit_prefix: cfg.unit_prefix(),
        relay_url,
        private_key_nsec,
        auth_tag: str_field(agent, "auth_tag"),
        agent_command,
        agent_args,
        system_prompt: str_field(agent, "system_prompt"),
        idle_timeout_seconds: agent.get("idle_timeout_seconds").and_then(Value::as_u64),
        max_turn_duration_seconds: agent
            .get("max_turn_duration_seconds")
            .and_then(Value::as_u64),
        parallelism: agent
            .get("parallelism")
            .and_then(Value::as_u64)
            .map(|n| n as u32),
        respond_to: str_field(agent, "respond_to"),
        respond_to_allowlist: agent
            .get("respond_to_allowlist")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        env_vars,
    };
    Ok((spec, host))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Value {
        json!({
            "name": "Hermes GPT",
            "relay_url": "wss://buzz.example.com",
            "private_key_nsec": "nsec1abc",
            "auth_tag": "[\"auth\",\"aa\",\"\",\"bb\"]",
            "agent_command": "buzz-agent",
            "agent_args": [],
            "system_prompt": "Be terse.",
            "model": "claude-sonnet-4-5",
            "provider": "anthropic",
            "idle_timeout_seconds": 900,
            "max_turn_duration_seconds": 7200,
            "parallelism": 2,
            "respond_to": "allowlist",
            "respond_to_allowlist": ["aaaa"],
            "env_vars": {"FOO": "bar"}
        })
    }

    fn cfg() -> config::Config {
        config::Config {
            default_host: Some("srv".into()),
            default_user: Some("buzz".into()),
            ..Default::default()
        }
    }

    #[test]
    fn info_advertises_the_required_fields() {
        let info = op_info();
        assert_eq!(info["ok"], json!(true));
        assert_eq!(info["name"], json!("ssh"));
        let req = info["config_schema"]["required"].as_array().unwrap();
        for f in ["host", "user", "runtime"] {
            assert!(req.iter().any(|v| v == f), "{f} should be required");
        }
    }

    #[test]
    fn unknown_op_is_an_error() {
        assert!(handle(&json!({"op":"undeploy"})).is_err());
        assert!(handle(&json!({})).is_err());
    }

    #[test]
    fn runtime_override_replaces_the_payload_command() {
        let (spec, host) = resolve(&payload(), &json!({"runtime":"hermes"}), &cfg()).unwrap();
        assert_eq!(host, "srv");
        // Desktop sent buzz-agent; the remote choice wins.
        assert_eq!(spec.agent_command, "hermes");
        assert_eq!(spec.agent_args, vec!["acp", "--accept-hooks"]);
    }

    #[test]
    fn payload_command_is_used_when_no_override() {
        let (spec, _) = resolve(&payload(), &json!({}), &cfg()).unwrap();
        assert_eq!(spec.agent_command, "buzz-agent");
    }

    #[test]
    fn unknown_runtime_is_rejected_with_the_known_list() {
        let err = resolve(&payload(), &json!({"runtime":"llama"}), &cfg()).unwrap_err();
        assert!(err.contains("unknown runtime"));
        assert!(err.contains("hermes"));
    }

    #[test]
    fn ids_and_paths_derive_from_the_agent_name() {
        let (spec, _) = resolve(&payload(), &json!({}), &cfg()).unwrap();
        assert_eq!(spec.id, "hermes-gpt");
        assert_eq!(spec.unit_name(), "buzz-acp-hermes-gpt.service");
        assert_eq!(spec.workdir, "/home/buzz/buzz-agents/hermes-gpt");
    }

    #[test]
    fn model_and_provider_map_onto_runtime_env_vars() {
        let (spec, _) = resolve(&payload(), &json!({"runtime":"buzz-agent"}), &cfg()).unwrap();
        assert_eq!(
            spec.env_vars.get("BUZZ_AGENT_MODEL").map(String::as_str),
            Some("claude-sonnet-4-5")
        );
        assert_eq!(
            spec.env_vars.get("BUZZ_AGENT_PROVIDER").map(String::as_str),
            Some("anthropic")
        );
        // Runtimes without model env vars must not invent one.
        let (claude, _) = resolve(&payload(), &json!({"runtime":"claude"}), &cfg()).unwrap();
        assert!(claude.env_vars.keys().all(|k| k == "FOO"));
    }

    #[test]
    fn operator_env_is_preserved() {
        let (spec, _) = resolve(&payload(), &json!({}), &cfg()).unwrap();
        assert_eq!(spec.env_vars.get("FOO").map(String::as_str), Some("bar"));
    }

    #[test]
    fn missing_identity_fails_closed() {
        let mut p = payload();
        p["private_key_nsec"] = json!("");
        assert!(resolve(&p, &json!({}), &cfg()).is_err());

        let mut p = payload();
        p["relay_url"] = Value::Null;
        assert!(resolve(&p, &json!({}), &cfg()).is_err());
    }

    #[test]
    fn host_and_user_are_required_somewhere() {
        let empty = config::Config::default();
        let err = resolve(&payload(), &json!({}), &empty).unwrap_err();
        assert!(err.contains("host"));
        let err = resolve(&payload(), &json!({"host":"h"}), &empty).unwrap_err();
        assert!(err.contains("user"));
    }

    #[test]
    fn provider_config_overrides_config_defaults() {
        let (spec, host) = resolve(
            &payload(),
            &json!({"host":"other","user":"agentuser","workdir":"/srv/a"}),
            &cfg(),
        )
        .unwrap();
        assert_eq!(host, "other");
        assert_eq!(spec.user, "agentuser");
        assert_eq!(spec.workdir, "/srv/a");
    }

    #[test]
    fn unknown_payload_fields_are_ignored() {
        // Desktop documents added fields as "no protocol break" — never fail on them.
        let mut p = payload();
        p["some_future_field"] = json!({"nested": true});
        assert!(resolve(&p, &json!({}), &cfg()).is_ok());
    }
}
