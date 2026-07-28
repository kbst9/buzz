use crate::client::BuzzClient;
use crate::error::CliError;
use crate::InvitesCmd;

pub async fn dispatch(command: InvitesCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        InvitesCmd::Claim {
            code,
            policy_receipt,
        } => {
            let response = client
                .claim_invite(code.trim(), policy_receipt.as_deref())
                .await?;
            println!("{response}");
            Ok(())
        }
    }
}
