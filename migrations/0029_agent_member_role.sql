-- Agent-typed invite claims record the claimant as role 'bot' at the
-- community-membership level, so every client can classify invite-flow
-- agents from the NIP-43 roster it already consumes. These agents can carry
-- no NIP-OA profile tag: the keypair is generated on the agent host AFTER
-- the invite is minted, so no owner-signed artifact over the agent pubkey
-- can exist — the relay's claim transaction is the authoritative witness.

ALTER TABLE relay_members DROP CONSTRAINT relay_members_role_check;
ALTER TABLE relay_members
    ADD CONSTRAINT relay_members_role_check
    CHECK (role IN ('owner', 'admin', 'member', 'bot'));

-- Backfill members admitted through an agent-typed invite before this
-- migration. added_by = 'invite' plus a claim-time ownership mapping is
-- exactly that set: tag-flow agents are never relay_members rows (ViaOwner
-- membership), and humans never carry agent_owner_pubkey.
UPDATE relay_members rm
SET role = 'bot', updated_at = now()
WHERE rm.role = 'member'
  AND rm.added_by = 'invite'
  AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.community_id = rm.community_id
        AND u.pubkey = decode(rm.pubkey, 'hex')
        AND u.agent_owner_pubkey IS NOT NULL
  );
