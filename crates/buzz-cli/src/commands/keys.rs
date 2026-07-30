use crate::error::CliError;

/// `buzz keys generate` — mint a fresh Nostr keypair and print it as JSON.
///
/// Local-only and identity-free by design: this is the first step of
/// provisioning a standalone agent, before any `BUZZ_PRIVATE_KEY` exists.
/// The private key is printed exactly once and never stored — the caller
/// owns persistence (typically the agent unit's env file).
pub fn cmd_generate() -> Result<(), CliError> {
    let keys = nostr::Keys::generate();
    let out = serde_json::json!({
        "private_key": keys.secret_key().to_secret_hex(),
        "public_key": keys.public_key().to_hex(),
    });
    println!("{out}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use nostr::Keys;

    /// The printed pair must round-trip: parsing the private key yields the
    /// printed public key. (cmd_generate itself prints to stdout; this
    /// exercises the same construction.)
    #[test]
    fn generated_pair_round_trips() {
        let keys = Keys::generate();
        let secret_hex = keys.secret_key().to_secret_hex();
        let reparsed = Keys::parse(&secret_hex).expect("hex secret parses");
        assert_eq!(reparsed.public_key(), keys.public_key());
        assert_eq!(secret_hex.len(), 64);
    }
}
