import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

export const Route = createFileRoute("/files")({
  component: FilesRouteComponent,
});

const FilesRouteScreen = React.lazy(async () => {
  const module = await import("./FilesRouteScreen");
  return { default: module.FilesRouteScreen };
});

function FilesRouteComponent() {
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="files" />}>
      <FilesRouteScreen />
    </React.Suspense>
  );
}
