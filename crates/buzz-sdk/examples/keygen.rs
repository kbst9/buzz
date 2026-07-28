//! Generate a fresh Nostr keypair for a new agent identity.
//!
//! Usage:
//!   cargo run --release --example keygen
//!
//! Prints `secret=<hex>` and `pubkey=<hex>` on separate lines. Run this on
//! the machine that will host the agent — the secret never needs to leave it.

use nostr::Keys;

fn main() {
    let keys = Keys::generate();
    println!("secret={}", keys.secret_key().to_secret_hex());
    println!("pubkey={}", keys.public_key().to_hex());
}
