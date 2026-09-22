/**
 * Markdown parser utilities.
 * Parses raw markdown text and identifies syntax regions for decoration.
 *
 * 块级结构（标题 / 引用 / 围栏 / 分割线 …）的边界识别统一由
 * {@link BLOCK_STRUCTURES} 登记表驱动：扫描器只负责通用的
 * 「逐行扫描 + 围栏开闭状态机」，各结构自身的规则只写在登记项里。
 * 列表/任务列表与行内语法仍由本文件的专用规则处理。
 *
 * Each region has: { type, from, to, contentFrom, contentTo, meta, render? }
 * - from/to: full range including syntax markers
 * - contentFrom/contentTo: range of the actual content (excluding markers)
 * - meta: additional info (heading level, language, url, etc.)
 * - render: 块级结构的统一样式指令（见 block-structures.js）
 */

import { BLOCK_STRUCTURES } from './block-structures'

/**
 * @typedef {Object} MarkdownRegion
 * @property {string} type
 * @property {number} from
 * @property {number} to
 * @property {number} contentFrom
 * @property {number} contentTo
 * @property {Object} [meta]
 * @property {Object} [render]
 */

const FENCE_STRUCTURES = BLOCK_STRUCTURES.filter((s) => s.fence)
const LINE_STRUCTURES = BLOCK_STRUCTURES.filter((s) => !s.fence)

/**
 * Parse a document string and return all markdown regions.
 * @param {string} doc - The full document text
 * @returns {MarkdownRegion[]}
 */
export function parseMarkdownRegions(doc) {
  const regions = []
  const lines = doc.split('\n')
  let pos = 0

  // 通用围栏状态：{ structure, openStart, openLineEnd, markerChar, markerLen, meta }
  // null 表示当前不在任何围栏结构内；EOF 时仍未闭合的围栏不产出区域（历史行为）。
  let openFence = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineStart = pos
    const lineEnd = pos + line.length

    // --- 围栏结构：统一的开闭边界识别 ---
    if (openFence) {
      const { structure } = openFence
      const fenceMatch = line.match(structure.fence.openRe)
      if (fenceMatch && structure.fence.closes(openFence, fenceMatch)) {
        regions.push(
          buildBlockRegion(structure, {
            line,
            lineStart,
            lineEnd,
            match: fenceMatch,
            open: openFence
          })
        )
        openFence = null
        pos = lineEnd + 1
        continue
      }
      // 围栏内容行：跳过其他一切块/行内识别
      pos = lineEnd + 1
      continue
    }

    // 尚未进入围栏：检查任一登记的围栏结构是否在本行开启
    let opened = false
    for (const structure of FENCE_STRUCTURES) {
      const fenceMatch = line.match(structure.fence.openRe)
      if (fenceMatch) {
        openFence = {
          structure,
          openStart: lineStart,
          openLineEnd: lineEnd,
          markerChar: fenceMatch[1][0],
          markerLen: fenceMatch[1].length,
          meta: { language: fenceMatch[2].trim() }
        }
        opened = true
        break
      }
    }
    if (opened) {
      pos = lineEnd + 1
      continue
    }

    // --- 行内单发型块级结构：按登记表顺序尝试边界识别 ---
    let blockSwallowsLine = false
    for (const structure of LINE_STRUCTURES) {
      const match = structure.match(line)
      if (!match) continue
      regions.push(buildBlockRegion(structure, { line, lineStart, lineEnd, match }))
      // parseInline 的结构（如引用）命中后仍允许列表/行内规则继续处理本行；
      // 其余结构（标题、分割线）整行消费，跳过后续识别。
      blockSwallowsLine = !structure.parseInline
      break
    }
    if (blockSwallowsLine) {
      pos = lineEnd + 1
      continue
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)([-*+])\s(.+)$/)
    if (ulMatch) {
      const indent = ulMatch[1].length
      const markerStart = lineStart + indent
      regions.push({
        type: 'list-bullet',
        from: lineStart,
        to: lineEnd,
        contentFrom: markerStart + 2,
        contentTo: lineEnd,
        meta: { marker: ulMatch[2], markerFrom: markerStart, markerTo: markerStart + 1, indent }
      })
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+)\.\s(.+)$/)
    if (olMatch) {
      const indent = olMatch[1].length
      const markerStart = lineStart + indent
      const markerEnd = markerStart + olMatch[2].length + 1
      regions.push({
        type: 'list-ordered',
        from: lineStart,
        to: lineEnd,
        contentFrom: markerEnd + 1,
        contentTo: lineEnd,
        meta: { number: olMatch[2], markerFrom: markerStart, markerTo: markerEnd, indent }
      })
    }

    // Task list
    const taskMatch = line.match(/^(\s*[-*+]\s)\[([xX ])\]\s(.+)$/)
    if (taskMatch) {
      const checkStart = lineStart + taskMatch[1].length
      regions.push({
        type: 'task-list',
        from: lineStart,
        to: lineEnd,
        contentFrom: checkStart + 4,
        contentTo: lineEnd,
        meta: {
          checked: taskMatch[2].toLowerCase() === 'x',
          checkFrom: checkStart,
          checkTo: checkStart + 3
        }
      })
    }

    // Inline patterns on this line
    parseInlineRegions(line, lineStart, regions)

    pos = lineEnd + 1
  }

  return regions
}

/**
 * Build a region from a block-structure registry entry and normalize it.
 */
function buildBlockRegion(structure, ctx) {
  const region = structure.buildRegion(ctx)
  return { type: structure.type, ...region }
}

/**
 * Parse inline markdown patterns within a single line.
 */
function parseInlineRegions(line, lineStart, regions) {
  // Image: ![alt](url)
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
  let m
  while ((m = imgRe.exec(line)) !== null) {
    regions.push({
      type: 'image',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[1].length,
      meta: { alt: m[1], url: m[2] }
    })
  }

  // Link: [text](url) — but not images
  const linkRe = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g
  while ((m = linkRe.exec(line)) !== null) {
    regions.push({
      type: 'link',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 1,
      contentTo: lineStart + m.index + 1 + m[1].length,
      meta: { text: m[1], url: m[2] }
    })
  }

  // Bold: **text** or __text__
  const boldRe = /(\*\*|__)(?!\s)(.+?)(?<!\s)\1/g
  while ((m = boldRe.exec(line)) !== null) {
    regions.push({
      type: 'bold',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[2].length,
      meta: { marker: m[1] }
    })
  }

  // Italic: *text* or _text_ (not bold)
  const italicRe = /(?<!\*|\w)(\*|_)(?!\s|\1)(.+?)(?<!\s)\1(?!\*|\w)/g
  while ((m = italicRe.exec(line)) !== null) {
    // Skip if this is part of a bold marker
    const fullFrom = lineStart + m.index
    const isBold = regions.some(r => r.type === 'bold' && r.from <= fullFrom && r.to >= fullFrom + m[0].length)
    if (isBold) continue
    regions.push({
      type: 'italic',
      from: fullFrom,
      to: fullFrom + m[0].length,
      contentFrom: fullFrom + 1,
      contentTo: fullFrom + 1 + m[2].length,
      meta: { marker: m[1] }
    })
  }

  // Strikethrough: ~~text~~
  const strikeRe = /~~(?!\s)(.+?)(?<!\s)~~/g
  while ((m = strikeRe.exec(line)) !== null) {
    regions.push({
      type: 'strikethrough',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + 2,
      contentTo: lineStart + m.index + 2 + m[1].length,
      meta: {}
    })
  }

  // Inline code: `code`
  const codeRe = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g
  while ((m = codeRe.exec(line)) !== null) {
    const markerLen = m[1].length
    regions.push({
      type: 'inline-code',
      from: lineStart + m.index,
      to: lineStart + m.index + m[0].length,
      contentFrom: lineStart + m.index + markerLen,
      contentTo: lineStart + m.index + markerLen + m[2].length,
      meta: { markerLen }
    })
  }
}

/**
 * Check if a position falls within any region.
 * @param {MarkdownRegion[]} regions
 * @param {number} pos
 * @returns {MarkdownRegion|null}
 */
export function regionAtPos(regions, pos) {
  return regions.find(r => pos >= r.from && pos <= r.to) || null
}

/**
 * Check if a region overlaps a single cursor line range.
 *
 * 所有块级 / 行内结构共用这一套光标命中判定：区域与行区间相交即命中。
 * @param {MarkdownRegion} region
 * @param {number} lineFrom
 * @param {number} lineTo
 * @returns {boolean}
 */
export function cursorOnRegion(region, lineFrom, lineTo) {
  return region.from <= lineTo && region.to >= lineFrom
}

/**
 * Check if a region overlaps with any of the cursor line ranges.
 * @param {MarkdownRegion} region
 * @param {{from: number, to: number}[]} lineRanges
 * @returns {boolean}
 */
export function regionHitsLineRanges(region, lineRanges) {
  return lineRanges.some((r) => cursorOnRegion(region, r.from, r.to))
}
