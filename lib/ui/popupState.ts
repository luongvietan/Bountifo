import { isSupportedEngagementUrl } from "../ids";
import type { JobDescriptor } from "../job/descriptor";

export interface PopupView {
  canExport: boolean;
  job: JobDescriptor | null;
  statusLines: { label: string; value: string }[];
}

const TERMINAL = new Set<JobDescriptor["phase"]>(["done", "failed", "cancelled"]);

function phaseLabel(phase: JobDescriptor["phase"]): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

export function viewFor(url: string | null, job: JobDescriptor | null): PopupView {
  const canExport =
    url !== null &&
    isSupportedEngagementUrl(url) &&
    (job === null || TERMINAL.has(job.phase));
  const statusLines =
    job === null
      ? []
      : [
          { label: "Phase", value: phaseLabel(job.phase) },
          { label: "Progress", value: `${job.counters.unitDone}/${job.counters.unitTotal} units` },
          { label: "Known Issues", value: `${job.counters.kiDone}/${job.counters.kiTotal}` },
          { label: "Warnings", value: String(job.warnings) },
          { label: "Conflicts", value: String(job.unresolvedConflicts) },
        ];
  return { canExport, job, statusLines };
}
