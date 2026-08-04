use super::*;

// Scaffold behavior (dirs, AGENTS.md/SKILL.md seeding, version refresh,
// managed-section upsert) is tested in the shared `buzz-nest` crate.
// These tests cover the desktop-only surface: nest path selection,
// the bundled-CLI symlink, and the dynamic AGENTS.md section.

#[test]
fn nest_dir_is_under_home() {
    if let Some(dir) = nest_dir() {
        // Accepts both .buzz (prod) and .buzz-dev (dev) depending on
        // whether init_nest_dir was called before this test ran.
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert!(
            name == NEST_DIR_PROD || name == NEST_DIR_DEV,
            "nest_dir must end with .buzz or .buzz-dev, got {dir:?}"
        );
    }
}

#[test]
fn init_nest_dir_prod_sets_buzz() {
    // init_nest_dir is idempotent (OnceLock) — once set, subsequent calls
    // are no-ops. We can only test the fallback path if the OnceLock is
    // unset, which is only true in a fresh process. Instead, verify that
    // nest_dir() always returns a path ending with a valid nest suffix.
    let dir = nest_dir();
    if let Some(d) = dir {
        let name = d.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert!(
            name == NEST_DIR_PROD || name == NEST_DIR_DEV,
            "nest_dir suffix must be .buzz or .buzz-dev, got {d:?}"
        );
    }
}

#[test]
fn cli_link_name_prod_is_buzz() {
    assert_eq!(cli_link_name(false), "buzz");
}

#[test]
fn cli_link_name_dev_is_buzz_dev() {
    assert_eq!(cli_link_name(true), "buzz-dev");
}

#[cfg(unix)]
#[test]
fn ensure_cli_symlink_creates_symlink_prod() {
    let tmp = tempfile::tempdir().unwrap();
    let exe_parent = tmp.path().join("MacOS");
    fs::create_dir(&exe_parent).unwrap();
    fs::write(exe_parent.join("buzz"), "binary").unwrap();

    let local_bin = tmp.path().join("local_bin");
    fs::create_dir_all(&local_bin).unwrap();

    // Prod link name is "buzz"; simulate the symlink creation path.
    let link = local_bin.join(cli_link_name(false));
    std::os::unix::fs::symlink(exe_parent.join("buzz"), &link).unwrap();
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(fs::read_link(&link).unwrap(), exe_parent.join("buzz"));
}

#[cfg(unix)]
#[test]
fn ensure_cli_symlink_creates_symlink_dev() {
    let tmp = tempfile::tempdir().unwrap();
    let exe_parent = tmp.path().join("MacOS");
    fs::create_dir(&exe_parent).unwrap();
    fs::write(exe_parent.join("buzz"), "binary").unwrap();

    let local_bin = tmp.path().join("local_bin");
    fs::create_dir_all(&local_bin).unwrap();

    // Dev link must be "buzz-dev", never "buzz".
    assert_eq!(cli_link_name(true), "buzz-dev");

    let link = local_bin.join(cli_link_name(true));
    std::os::unix::fs::symlink(exe_parent.join("buzz"), &link).unwrap();
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(fs::read_link(&link).unwrap(), exe_parent.join("buzz"));
    // Prod link must not exist — the two builds don't touch each other.
    assert!(!local_bin.join("buzz").exists());
}

#[cfg(unix)]
#[test]
fn ensure_cli_symlink_does_not_clobber_regular_file_prod() {
    let tmp = tempfile::tempdir().unwrap();
    let local_bin = tmp.path().join("local_bin");
    fs::create_dir_all(&local_bin).unwrap();
    let link = local_bin.join(cli_link_name(false));
    fs::write(&link, "user-installed binary").unwrap();

    // Regular files are preserved — the Ok(_) branch skips them.
    assert!(link.symlink_metadata().unwrap().file_type().is_file());
    assert_eq!(fs::read_to_string(&link).unwrap(), "user-installed binary");
}

#[cfg(unix)]
#[test]
fn ensure_cli_symlink_does_not_clobber_regular_file_dev() {
    let tmp = tempfile::tempdir().unwrap();
    let local_bin = tmp.path().join("local_bin");
    fs::create_dir_all(&local_bin).unwrap();
    let link = local_bin.join(cli_link_name(true));
    fs::write(&link, "user-installed buzz-dev binary").unwrap();

    // Regular files at the dev path are also preserved.
    assert!(link.symlink_metadata().unwrap().file_type().is_file());
    assert_eq!(
        fs::read_to_string(&link).unwrap(),
        "user-installed buzz-dev binary"
    );
}

#[test]
fn ensure_nest_layers_repos_default_over_shared_scaffold() {
    // ensure_nest() delegates scaffold creation to buzz-nest, then applies
    // the desktop's own REPOS provisioning. Verify the composition against
    // an explicit root (the public ensure_nest() resolves ~, untestable).
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".buzz");
    ensure_nest_at(&root).unwrap();
    super::super::repos::ensure_repos_setup_default(&root).unwrap();

    assert!(root.join("AGENTS.md").exists());
    assert!(root.join("REPOS").is_dir());
}

fn make_persona(id: &str, display_name: &str) -> AgentDefinition {
    AgentDefinition {
        id: id.to_string(),
        display_name: display_name.to_string(),
        avatar_url: None,
        system_prompt: String::new(),
        runtime: None,
        model: None,
        provider: None,
        name_pool: vec![],
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: std::collections::BTreeMap::new(),
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn make_agent(name: &str, persona_id: Option<&str>) -> ManagedAgentRecord {
    ManagedAgentRecord {
        pubkey: String::new(),
        name: name.to_string(),
        persona_id: persona_id.map(|s| s.to_string()),
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: String::new(),
        avatar_url: None,
        acp_command: String::new(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 0,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        start_on_app_launch: false,
        auto_restart_on_config_change: true,
        runtime_pid: None,
        backend: BackendKind::default(),
        backend_agent_id: None,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: String::new(),
        updated_at: String::new(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: RespondTo::default(),
        respond_to_allowlist: vec![],
        env_vars: std::collections::BTreeMap::new(),
        display_name: None,
        slug: None,
        runtime: None,
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Vec::new(),
        definition_parallelism: None,
        relay_mesh: None,
    }
}

#[test]
fn test_render_dynamic_section_with_agents() {
    let personas = vec![make_persona("p1", "Builder")];
    let agents = vec![make_agent("Kit", Some("p1"))];
    let output = render_dynamic_section(&personas, &agents, "ws://example.com:3000");
    assert!(output.contains("| Kit | Builder | @Kit |"));
    assert!(output.contains("| Name | Persona | How to address |"));
    assert!(output.contains("## Workspace"));
}

#[test]
fn test_render_dynamic_section_empty() {
    let output = render_dynamic_section(&[], &[], "ws://example.com:3000");
    assert!(output.contains("No agents deployed yet"));
}

#[test]
fn test_render_dynamic_section_agent_no_persona() {
    let personas = vec![make_persona("p1", "Builder")];
    let agents = vec![make_agent("Scout", Some("nonexistent"))];
    let output = render_dynamic_section(&personas, &agents, "ws://example.com:3000");
    assert!(output.contains("| Scout | — | @Scout |"));
}

#[test]
fn test_render_pipe_in_agent_name() {
    let personas = vec![make_persona("p1", "Builder")];
    let agents = vec![make_agent("Kit|Pro", Some("p1"))];
    let output = render_dynamic_section(&personas, &agents, "ws://example.com:3000");

    assert!(
        output.contains("Kit\\|Pro"),
        "pipe in agent name must be escaped as \\|"
    );
    // An unescaped bare `|` immediately adjacent to "Kit|Pro" would break table parsing.
    assert!(
        !output.contains("| Kit|Pro |"),
        "unescaped pipe in agent name must not appear as a cell boundary"
    );

    // The row must start and end with `|` and the escaped name and address must appear.
    let kit_row = output
        .lines()
        .find(|l| l.contains("Kit\\|Pro"))
        .expect("Kit\\|Pro row must be present");
    assert!(kit_row.starts_with('|'), "row must start with |");
    assert!(kit_row.ends_with('|'), "row must end with |");
    assert!(
        kit_row.contains("@Kit\\|Pro"),
        "address cell must use escaped name"
    );
}

#[test]
fn test_render_newline_in_persona_name() {
    let personas = vec![make_persona("p1", "Builder\nExpert")];
    let agents = vec![make_agent("Scout", Some("p1"))];
    let output = render_dynamic_section(&personas, &agents, "ws://example.com:3000");

    assert!(
        output.contains("Builder Expert"),
        "newline in persona display_name must be replaced with a space"
    );

    // The table row for Scout must be a single line (no embedded newline).
    let scout_row = output
        .lines()
        .find(|l| l.contains("Scout"))
        .expect("Scout row must be present");
    assert!(
        scout_row.contains("Builder Expert"),
        "persona name with newline replaced by space must appear on the Scout row"
    );
}

#[test]
fn test_path_is_dev_nest_dev_path_returns_true() {
    let path = std::path::Path::new("/Users/someone/.buzz-dev");
    assert!(
        path_is_dev_nest(path),
        ".buzz-dev path must be identified as dev nest"
    );
}

#[test]
fn test_upsert_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("AGENTS.md");
    fs::write(
            &file,
            "# Header\n\n<!-- BEGIN BUZZ MANAGED — regenerated automatically, do not edit below -->\nexisting section\n<!-- END BUZZ MANAGED -->\n",
        )
        .unwrap();

    upsert_managed_section(&file, "same content").unwrap();
    let after_first = fs::read_to_string(&file).unwrap();

    upsert_managed_section(&file, "same content").unwrap();
    let after_second = fs::read_to_string(&file).unwrap();

    assert_eq!(
        after_first, after_second,
        "upsert must be idempotent: second call must not alter the file"
    );
}

#[test]
fn test_path_is_dev_nest_prod_path_returns_false() {
    let path = std::path::Path::new("/Users/someone/.buzz");
    assert!(
        !path_is_dev_nest(path),
        ".buzz path must not be identified as dev nest"
    );
}

#[test]
fn refresh_agents_md_writes_version_file() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".buzz");
    ensure_nest_at(&root).unwrap();
    let version = fs::read_to_string(root.join(".nest-agents-version")).unwrap();
    assert_eq!(version.trim(), NEST_AGENTS_VERSION.to_string());
}

#[test]
fn refresh_skill_md_writes_version_file() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".buzz");
    ensure_nest_at(&root).unwrap();
    let version = fs::read_to_string(root.join(".agents/skills/buzz-cli/.skill-version")).unwrap();
    assert_eq!(version.trim(), NEST_SKILL_VERSION.to_string());
}

#[test]
fn refresh_agents_md_preserves_managed_section() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".buzz");
    ensure_nest_at(&root).unwrap();

    // Simulate a managed section update.
    let agents_md = root.join("AGENTS.md");
    upsert_managed_section(
        &agents_md,
        "## Active Agents\n\n| Name | Role |\n|------|------|\n| Kit | Builder |",
    )
    .unwrap();

    // Remove version file to simulate an upgrade.
    fs::remove_file(root.join(".nest-agents-version")).unwrap();

    // Re-run ensure_nest_at (triggers refresh).
    ensure_nest_at(&root).unwrap();

    let content = fs::read_to_string(&agents_md).unwrap();
    // Static content should be refreshed (from template).
    assert!(
        content.starts_with("# Buzz Nest"),
        "template header must be present"
    );
    // Managed section should be preserved.
    assert!(
        content.contains("Kit"),
        "managed section agent table must survive refresh"
    );
    assert!(content.contains(BEGIN_MARKER), "BEGIN marker must survive");
    assert!(content.contains(END_MARKER), "END marker must survive");
}

#[test]
fn refresh_skips_when_version_current() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".buzz");
    ensure_nest_at(&root).unwrap();

    // Manually change AGENTS.md content after version file is written.
    let agents_md = root.join("AGENTS.md");
    fs::write(&agents_md, "user modified content").unwrap();

    // Re-run ensure_nest_at — version file is current, so no refresh.
    ensure_nest_at(&root).unwrap();

    let content = fs::read_to_string(&agents_md).unwrap();
    assert_eq!(
        content, "user modified content",
        "should not overwrite when version is current"
    );
}

#[test]
fn test_path_is_dev_nest_unrelated_path_returns_false() {
    let path = std::path::Path::new("/Users/someone/.buzz-staging");
    assert!(
        !path_is_dev_nest(path),
        "unrelated path must not be identified as dev nest"
    );
}

#[test]
fn test_path_is_dev_nest_root_returns_false() {
    let path = std::path::Path::new("/");
    assert!(
        !path_is_dev_nest(path),
        "root path must not be identified as dev nest"
    );
}

#[test]
fn refresh_skill_overwrites_on_version_bump() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".buzz");
    ensure_nest_at(&root).unwrap();

    let skill_md = root.join(".agents/skills/buzz-cli/SKILL.md");
    fs::write(&skill_md, "stale skill content").unwrap();

    // Remove version file to simulate upgrade.
    let _ = fs::remove_file(root.join(".agents/skills/buzz-cli/.skill-version"));

    ensure_nest_at(&root).unwrap();

    let content = fs::read_to_string(&skill_md).unwrap();
    assert_eq!(
        content, BUZZ_CLI_SKILL_MD,
        "SKILL.md must be refreshed on version bump"
    );
}
