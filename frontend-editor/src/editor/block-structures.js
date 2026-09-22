/**
 * Unified block-level structure registry.
 *
 * Headings, blockquotes and fenced code blocks (and any future block
 * structure) share one boundary scanner (markdown-parser.js), one cursor
 * hit-test and one decoration-rule applicator (decoration-plugin.js).
 * Adding a new block structure only requires appending one entry here.
 *
 * Boundary recognition
 * --------------------
 * Each entry provides:
 *
 * - type:       region type emitted by the parser and switched on by the
 *               decoration applicator.
 * - terminal:   when true, a matching line is fully consumed by the
 *               structure (the shared scanner skips its other passes).
 *               When false, the line is merely annotated and the scanner
 *               keeps running the list / task / inline passes, so one
 *               line can carry several overlapping regions.
 * - match(ctx): inspects a single line (ctx: { line, lines, index,
 *               lineStart, lineEnd }) and returns:
 *
 *     null              -> the line does not belong to this structure
 *     region            -> a single-line structure. A region is
 *                          { from, to, contentFrom, contentTo, meta }
 *     { open, marker, region } -> a multi-line container opens. The
 *                          entry owns every following line until
 *                          close(ctx, marker) returns true, then
 *                          finish(ctx, marker, region) emits the final
 *                          region at the closing line.
 *
 * - close / finish / leaveOpen drive the container lifecycle. At EOF the
 *   scanner calls leaveOpen(marker, region): return a region to emit it
 *   or null to suppress it.
 *
 * Decoration mapping
 * ------------------
 * `decorate(region)` returns a list of declarative rules. Every rule is
 * one of:
 *
 *   { range: [from, to], className }
 *       Always-on mark decoration.
 *
 *   { range, line: true, className }
 *       Always-on line decoration; `range` is a selector:
 *       'first' | 'last' | 'all'.
 *
 *   { range: [from, to] | selector, active, inactive, line? }
 *       Cursor-aware rule. `active` / `inactive` pick the branch based on
 *       the shared hit-test. Each branch is `{ className }` or null.
 *       Without `line`, a selector range marks the whole fence line(s);
 *       with `line: true` it produces line decorations instead.
 *
 * Widget-producing structures (hr, image, ...) keep their bespoke rules
 * in the plugin; this registry stays free of CodeMirror/DOM imports.
 */

const FENCE_RE = /^(`{3,}|~{3,})(.*)$/
const FENCE_OPEN_RE = /^(`{3,}|~{3,})/
const HEADING_RE = /^(#{1,6})\s+(.+)$/
const BLOCKQUOTE_RE = /^(>\s?)(.*)$/

/**
 * The single extension point for block-level structures.
 * The container entry (code-block) must precede single-line entries:
 * once a container is open, its close/body rules own the line and no
 * other matcher runs.
 */
export const blockStructures = [
  // === Fenced code block: multi-line container ===
  {
    type: 'code-block',
    terminal: true,

    match({ line, lineStart }) {
      const fence = line.match(FENCE_RE)
      if (!fence) return null
      return {
        open: true,
        marker: {
          char: fence[1][0],
          markerLen: fence[1].length
        },
        region: {
          from: lineStart,
          contentFrom: lineStart,
          meta: { language: fence[2].trim() }
        }
      }
    },

    // A fence closes the container only when its marker is at least as
    // long as the opening one and uses the same fence character.
    close({ line }, { char, markerLen }) {
      const fence = line.match(FENCE_OPEN_RE)
      return !!fence && fence[1][0] === char && fence[1].length >= markerLen
    },

    finish({ lineEnd }, marker, region) {
      return {
        ...region,
        to: lineEnd,
        contentTo: lineEnd
      }
    },

    // Unclosed fences: keep the historical rendering (no code-block
    // region, inner text stays plain) while the scanner still consumes
    // the rest of the document so no inner syntax leaks out.
    leaveOpen() {
      return null
    },

    decorate() {
      return [
        // Code styling on every line of the block (line decoration).
        { range: 'all', line: true, className: 'md-code-block' },
        // Fences are only visible while the cursor is in the block.
        {
          range: 'first',
          active: null,
          inactive: { className: 'md-syntax-hidden' }
        },
        {
          range: 'last',
          active: null,
          inactive: { className: 'md-syntax-hidden' }
        }
      ]
    }
  },

  // === Heading: single-line terminal structure ===
  {
    type: 'heading',
    terminal: true,

    match({ line, lineStart, lineEnd }) {
      const m = line.match(HEADING_RE)
      if (!m) return null
      const level = m[1].length
      // Legacy range semantics: the mark covers `#` plus the single
      // required space; the styled content starts right after.
      const markFrom = lineStart
      const markTo = lineStart + level + 1
      return {
        from: lineStart,
        to: lineEnd,
        contentFrom: markTo,
        contentTo: lineEnd,
        meta: { level, markFrom, markTo }
      }
    },

    decorate(region) {
      const { level, markFrom, markTo } = region.meta
      return [
        {
          range: [region.contentFrom, region.to],
          className: `md-heading md-heading--${level}`
        },
        {
          range: [markFrom, markTo],
          active: { className: 'md-heading-mark' },
          inactive: { className: 'md-syntax-hidden' }
        }
      ]
    }
  },

  // === Blockquote: single-line annotating structure ===
  // The same line may additionally be a list / task line and carry
  // inline syntax, so the shared scanner keeps going after this match.
  {
    type: 'blockquote',
    terminal: false,

    match({ line, lineStart, lineEnd }) {
      const m = line.match(BLOCKQUOTE_RE)
      if (!m) return null
      const markTo = lineStart + m[1].length
      return {
        from: lineStart,
        to: lineEnd,
        contentFrom: markTo,
        contentTo: lineEnd,
        meta: { markFrom: lineStart, markTo }
      }
    },

    decorate(region) {
      const { markFrom, markTo } = region.meta
      return [
        { range: [region.from, region.to], className: 'md-blockquote' },
        {
          range: [markFrom, markTo],
          active: { className: 'md-syntax-visible' },
          inactive: { className: 'md-syntax-hidden' }
        }
      ]
    }
  }
]

/**
 * Look up the registered structure for a region type.
 */
export function getBlockStructure(type) {
  return blockStructures.find((s) => s.type === type) || null
}
