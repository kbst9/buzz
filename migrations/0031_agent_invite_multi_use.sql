-- Multi-use agent invites: one invite provisions a fleet.
--
-- 0027 pinned agent-typed invites to max_uses = 1 so a leaked code could not
-- mint an unbounded set of identities attributed to the owner. That per-agent
-- ceremony (one desktop dialog round-trip per agent) does not scale to fleet
-- provisioning, where one owner deliberately stands up tens of agents from a
-- config file in one pass.
--
-- Replace the single-use pin with the weaker invariant that actually carries
-- the security property: agent invites must be BOUNDED. `max_uses` stays
-- limited to 1..10000 by the 0025 range CHECK; what is newly allowed is a
-- value greater than one. A leaked fleet code's blast radius is the invite's
-- explicit remaining budget and its expiry — both owner-chosen, both
-- revocable by expiry — instead of unbounded.
--
-- Unlimited (`max_uses IS NULL`) agent invites remain forbidden.
ALTER TABLE relay_invites
    DROP CONSTRAINT relay_invites_agent_owner_single_use,
    ADD CONSTRAINT relay_invites_agent_owner_bounded
        CHECK (agent_owner IS NULL OR max_uses IS NOT NULL);
