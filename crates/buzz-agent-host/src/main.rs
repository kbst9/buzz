//! `buzz-agent-host` binary entry point.

use clap::Parser;
use tracing::info;

/// Always-on daemon that runs Buzz agents on this machine, controlled
/// over the relay by community members.
#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Path to the daemon config file.
    #[arg(
        long,
        env = "BUZZ_HOST_CONFIG",
        default_value = "/etc/buzz-agent-host/config.toml"
    )]
    config: std::path::PathBuf,

    /// Print the daemon's public key (register it as a community member)
    /// and exit.
    #[arg(long)]
    print_pubkey: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();
    let config = buzz_agent_host::HostConfig::load(&args.config)?;
    let keys = buzz_agent_host::state::load_or_generate_daemon_keys(&config.state_dir)?;

    if args.print_pubkey {
        println!("{}", keys.public_key().to_hex());
        return Ok(());
    }

    let mut daemon = buzz_agent_host::Daemon::new(config, keys)?;
    info!(
        pubkey = %daemon.public_key().to_hex(),
        "buzz-agent-host starting — this pubkey must be a community member"
    );
    daemon.reconcile().await;
    daemon.run().await?;
    Ok(())
}
