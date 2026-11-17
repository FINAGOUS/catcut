// Compound clips / nested timelines (P2, M4): a Project used as a Clip
// inside another Project. The child project is rendered FIRST to an
// intermediate MP4 (see resolveCompoundClips in export.ts — the render
// itself lives there because it needs exportProjectInner; this module
// stays pure: types, validation, paths), then the parent treats the
// intermediate as an ordinary source file. The parent may still apply
// its own zoom/colour/text/etc. on top of the compound clip — those
// filters see the rendered child picture, exactly like any other clip.
//
// Rules (enforced here, not silently worked around):
// - Nesting depth is at most 2: parent -> child -> grandchild. A
//   compound clip inside a depth-2 project (i.e. one that would create
//   a 3rd level) throws. Depth counts compound levels below the top
//   project: the top project is depth 0, its children depth 1, its
//   grandchildren depth 2.
// - Resampling rule: the child is rendered at the PARENT's width/height/
//   fps (the child's own canvas is overridden for the render). A child
//   whose canvas differs from the parent's is resampled to the parent's
//   — the parent export always comes out at the parent's size.
// - The compound clip's in/out select a window on the CHILD timeline
//   (child project time, after the child's own transitions). out must
//   not exceed the child project's total duration.
// - For a compound clip, `source` is ignored — pass '' (validation
//   throws on a non-empty source so a typo'd path cannot be mistaken
//   for the child project).
// - A child project with no clips, or a window outside it, throws.
// - Each child render goes into its own subdirectory
//   `compound-d<depth>-c<clipIdx>/render.mp4` next to the parent
//   output: the child's own prep files (mask PNGs, .trf, .cube, .ass,
//   portrait masks) are all named per clip index, so rendering a child
//   into the parent's directory would collide with the parent's files
//   (and with a grandchild's). The intermediate files are kept as an
//   audit trail, like the mask PNGs and the .ass file.
// LGPL note: a compound clip adds no new FFmpeg filters — the child
// render uses exactly the filters the child's own clips already use,
// and the parent sees an ordinary MP4 input. Nothing new to re-check
// on the BtbN LGPL 9.0 build beyond what the child already needs.
import { join } from 'node:path';
import { projectDuration, type Clip, type Project } from './project.js';

/** Maximum compound nesting depth (parent -> child -> grandchild). */
export const MAX_COMPOUND_DEPTH = 2;

/** A compound clip references a whole child project. */
export interface CompoundRef {
  /** The child project (its width/height/fps are overridden by the
   *  parent's at render time — see the resampling rule above). */
  project: Project;
}

/** Validate a compound clip against its child project and the current
 *  nesting depth. Throws on anything v1 cannot do. `childDuration` is
 *  projectDuration(child) — pass it in so this stays pure. */
export function validateCompoundClip(
  clip: Clip,
  child: Project,
  childDuration: number,
  depth: number,
): void {
  if (depth >= MAX_COMPOUND_DEPTH) {
    throw new Error(
      `clip ${clip.id}: compound nesting deeper than ${MAX_COMPOUND_DEPTH} levels ` +
        `is not supported (parent -> child -> grandchild is the limit)`,
    );
  }
  if (clip.source !== '') {
    throw new Error(
      `clip ${clip.id}: compound clips ignore source; pass '' (got ${JSON.stringify(clip.source)})`,
    );
  }
  if (child.clips.length === 0) {
    throw new Error(`clip ${clip.id}: compound child project has no clips`);
  }
  if (clip.in < 0) {
    throw new Error(`clip ${clip.id}: compound in ${clip.in} must be >= 0`);
  }
  if (clip.out <= clip.in) {
    throw new Error(
      `clip ${clip.id}: compound out ${clip.out} must be > in ${clip.in}`,
    );
  }
  if (clip.out > childDuration + 1e-6) {
    throw new Error(
      `clip ${clip.id}: compound out ${clip.out} exceeds child project ` +
        `duration ${childDuration.toFixed(3)}s`,
    );
  }
}

/** Directory for one child render (per depth + clip index, so a
 *  grandchild can never overwrite its parent's intermediate). */
export function compoundRenderDir(dir: string, depth: number, clipIndex: number): string {
  return join(dir, `compound-d${depth}-c${clipIndex}`);
}

/** Intermediate MP4 path for one child render. */
export function compoundIntermediatePath(dir: string, depth: number, clipIndex: number): string {
  return join(compoundRenderDir(dir, depth, clipIndex), 'render.mp4');
}

/** Total duration of a child project (its own transitions included). */
export function compoundChildDuration(child: Project): number {
  return projectDuration(child);
}
