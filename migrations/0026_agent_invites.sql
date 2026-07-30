-- Agent-typed invites: owner-attributed provisioning for standalone agents.
--
-- A NIP-OA auth tag binds owner_sig(agent_pubkey), so provisioning a
-- standalone agent needs a key-specific round-trip through the owner's
-- secret: generate the keypair on the host, carry the pubkey to the owner,
-- mint the tag, carry it back. An agent-typed invite breaks that dependency:
-- the invite is key-agnostic and records the intended owner (the minter) at
-- mint time; whichever keypair claims it is bound to that owner inside the
-- claim transaction by writing `users.agent_owner_pubkey` — the same mapping
-- a verified NIP-OA tag materializes at AUTH time. The owner secret never
-- leaves the minting client and the agent secret never leaves its host.
--
-- `agent_owner` is the lowercase hex pubkey all claimants are attributed to;
-- NULL means a regular member invite (existing behavior, untouched). Agent
-- invites are pinned to max_uses = 1 — one invite, one agent identity — so a
-- leaked code cannot mint a fleet attributed to the owner.
ALTER TABLE relay_invites
    ADD COLUMN agent_owner TEXT
        CONSTRAINT relay_invites_agent_owner_format
        CHECK (agent_owner IS NULL OR agent_owner ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT relay_invites_agent_owner_single_use
        CHECK (agent_owner IS NULL OR max_uses = 1);
