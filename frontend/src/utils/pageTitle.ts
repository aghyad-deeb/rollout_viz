/**
 * Build the document title for the current view.
 *
 * Base name resolution: experimentName if non-empty, else the basename of
 * sourceFile (directories and a trailing `.jsonl` stripped), else none.
 * With a base:    "<base>[ · rollout <n>] — Rollout Visualizer"
 * Without a base: "Shared rollout — Rollout Visualizer" in shared mode,
 *                 plain "Rollout Visualizer" otherwise.
 */
export function buildPageTitle(opts: {
  experimentName?: string;
  sourceFile?: string;
  rolloutN?: number;
  isSharedMode?: boolean;
}): string {
  const { experimentName, sourceFile, rolloutN, isSharedMode } = opts;

  let base: string | null = null;
  if (experimentName) {
    base = experimentName;
  } else if (sourceFile) {
    const basename = sourceFile.split('/').pop() || '';
    const stripped = basename.replace(/\.jsonl$/, '');
    if (stripped) base = stripped;
  }

  if (base) {
    const rollout = rolloutN !== undefined ? ` · rollout ${rolloutN}` : '';
    return `${base}${rollout} — Rollout Visualizer`;
  }
  return isSharedMode ? 'Shared rollout — Rollout Visualizer' : 'Rollout Visualizer';
}
