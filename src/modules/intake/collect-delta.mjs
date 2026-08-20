export function collectDelta(previousSnapshot, currentSnapshot) {
  const previousJobs = previousSnapshot?.jobsById ?? new Map();
  const currentJobs = currentSnapshot.jobsById;
  const added = [];
  const changed = [];
  const removed = [];

  for (const [jobId, job] of currentJobs) {
    const previous = previousJobs.get(jobId);
    if (!previous) {
      added.push(job);
    } else if (previous.contentHash !== job.contentHash) {
      changed.push(job);
    }
  }
  for (const [jobId, job] of previousJobs) {
    if (!currentJobs.has(jobId)) {
      removed.push(job);
    }
  }

  return Object.freeze({ new: added, changed, removed });
}

export function collectBridgeJobs(delta) {
  const seen = new Set();
  return [...delta.new, ...delta.changed].filter((job) => {
    if (job.issueState !== 'open' || seen.has(job.id)) {
      return false;
    }
    seen.add(job.id);
    return true;
  });
}
