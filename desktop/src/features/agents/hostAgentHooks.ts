import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createHostAgent, discoverAgentHosts } from "@/shared/api/tauri";
import type { CreateHostAgentInput } from "@/shared/api/types";

import { managedAgentsQueryKey, relayAgentsQueryKey } from "./hooks";

/**
 * Query/mutation hooks for `BackendKind::Host` agents — remote agents on a
 * `buzz-agent-host` daemon, discovered and controlled over the relay.
 */

export const agentHostsQueryKey = ["agent-hosts"] as const;

export function useAgentHostsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: agentHostsQueryKey,
    queryFn: discoverAgentHosts,
    staleTime: 30_000,
  });
}

export function useCreateHostAgentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateHostAgentInput) => createHostAgent(input),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
        queryClient.invalidateQueries({ queryKey: relayAgentsQueryKey }),
        queryClient.invalidateQueries({ queryKey: agentHostsQueryKey }),
      ]);
    },
  });
}
