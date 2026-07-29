import * as React from "react";

/** Code-split settings screen, loaded on first open from the shell. */
export const LazySettingsScreen = React.lazy(async () => {
  const module = await import("@/features/settings/ui/SettingsScreen");
  return { default: module.SettingsScreen };
});
