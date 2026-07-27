//! Thin entry point: one JSON request on stdin, one JSON response on stdout.
//!
//! Errors go to **stderr with a non-zero exit**, not to stdout. Desktop captures
//! stderr (capped) and stores it as the agent's `last_error`; a JSON error object
//! on stdout would instead surface as the generic "deploy response missing
//! agent_id".

use std::io::Read;

fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        fail(&format!("failed to read request from stdin: {e}"));
    }

    let request: serde_json::Value = match serde_json::from_str(input.trim()) {
        Ok(v) => v,
        Err(e) => fail(&format!("request is not valid JSON: {e}")),
    };

    match buzz_backend_ssh::handle(&request) {
        Ok(response) => println!("{response}"),
        Err(e) => fail(&e),
    }
}

fn fail(message: &str) -> ! {
    eprintln!("buzz-backend-ssh: {message}");
    std::process::exit(1);
}
