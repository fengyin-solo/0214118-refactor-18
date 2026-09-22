/**
 * Unified block-structure registry.
 *
 * 标题、引用、围栏（以及后续新增的块级结构）共用同一份声明式描述：
 * 每一条登记项都用同一套字段描述「边界识别 / 光标命中 / 样式规则」。
 *
 * 新增一种块级结构时，只需在 {@link BLOCK_STRUCTURES} 中追加一条登记项，
 * 解析器（markdown-parser.js 的通用行扫描 + 围栏开闭状态机）与装饰器
 * （decoration-plugin.js 的通用指令映射）无需任何改动。
 *
 * 本文件刻意不依赖 @codemirror/*，保持解析层可在任意环境复用；
 * 需要渲染为 Widget 的结构通过 render.widget 给出 widget 标识，
 * 具体 Widget 类在 decoration-plugin.js 的 WIDGETS 表中登记。
 *
 * 登记项字段：
 * - type:        区域类型（写入 region.type）
 * - fence:       围栏型结构的开闭配置；缺省表示行内单发型结构
 *   - openRe:    匹配开启围栏的行，捕获组 1 为围栏标记
 *   - closes(open, match): 判断当前行是否能闭合 open 状态
 * - match(line): 非围栏结构的行首匹配，返回 match 对象或 null
 * - parseInline: 命中的行是否继续解析行内语法（引用行内仍可有粗体/链接等）
 * - buildRegion(ctx): 由匹配结果生成区域及「样式指令」
 *
 * ctx = { line, lineStart, lineEnd, match, open }
 *   - 围栏闭合时 open 携带开启行状态：
 *     { openStart, openLineEnd, markerChar, markerLen, meta }
 *
 * buildRegion 返回：{ from, to, contentFrom, contentTo, meta, render }
 *
 * render —— 与结构一一对应的样式指令，装饰器只认指令、不认类型：
 * - contentClass:      常驻内容样式，范围默认 contentFrom..contentTo，
 *                      可用 contentRange 覆盖（引用需要整行含标记）
 * - contentRange:      { from, to } 覆盖 contentClass 的作用范围
 * - lineClass:         覆盖区域的每一行生成 line decoration（围栏背景）
 * - markerActiveClass: 光标命中区域时标记使用的样式；缺省表示命中时不装饰标记
 * - markers:           [{ from, to }] 随命中状态显隐/切换样式的语法标记
 * - hideLines + markerLines: 未命中时把 markerLines 列出的行整体隐藏（围栏）
 * - widget:            未命中时整体替换区域的 widget 标识（在 WIDGETS 中登记）
 */

/**
 * 一行开头是否为围栏标记（用于通用围栏状态机识别开启行）。
 * 捕获组 1 为围栏标记本身（``` 或 ~~~ 系列）。
 */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/

/**
 * 已开启的围栏是否被当前行闭合：标记同族（同为 ` 或 ~）、长度不短于开启标记。
 * 规则与历史实现保持一致（闭合行允许携带尾随内容）。
 */
function fenceCloses(open, match) {
  return match[1].length >= open.markerLen && match[1][0] === open.markerChar
}

/**
 * @type {Array<Object>} 顺序即同行多结构命中时的优先级（围栏最先，引用最后）。
 */
export const BLOCK_STRUCTURES = [
  // --- 围栏型：代码块（最先扫描，围栏内容行跳过其他块识别）---
  {
    type: 'code-block',
    fence: {
      openRe: FENCE_OPEN_RE,
      closes: fenceCloses
    },
    // 围栏没有「单发匹配」：buildRegion 仅在闭合时调用。
    // 未闭合围栏沿用历史行为（EOF 不产出区域），由扫描器统一兜底。
    buildRegion({ lineStart, lineEnd, open }) {
      return {
        from: open.openStart,
        to: lineEnd,
        contentFrom: open.openStart,
        contentTo: lineEnd,
        meta: { language: open.meta.language },
        render: {
          lineClass: 'md-code-block',
          // 未命中时隐藏起始/结束围栏行；命中时围栏行恢复原始语法（不装饰）
          hideLines: true,
          markerLines: [
            { from: open.openStart, to: open.openLineEnd },
            { from: lineStart, to: lineEnd }
          ]
        }
      }
    }
  },

  // --- 标题：# ~ ###### + 空格 + 内容 ---
  {
    type: 'heading',
    match: (line) => line.match(/^(#{1,6})\s+(.+)$/),
    parseInline: false,
    buildRegion({ lineStart, lineEnd, match }) {
      const level = match[1].length
      const markTo = lineStart + level + 1 // # 序列 + 其后的空格
      return {
        from: lineStart,
        to: lineEnd,
        contentFrom: markTo,
        contentTo: lineEnd,
        meta: { level, markFrom: lineStart, markTo },
        render: {
          contentClass: `md-heading md-heading--${level}`,
          markerActiveClass: 'md-heading-mark',
          markers: [{ from: lineStart, to: markTo }]
        }
      }
    }
  },

  // --- 分割线（块级、单行、整体替换为 widget）---
  {
    type: 'hr',
    match: (line) => line.match(/^(\*{3,}|-{3,}|_{3,})\s*$/),
    parseInline: false,
    buildRegion({ lineStart, lineEnd }) {
      return {
        from: lineStart,
        to: lineEnd,
        contentFrom: lineStart,
        contentTo: lineEnd,
        meta: {},
        render: { widget: 'hr' }
      }
    }
  },

  // --- 引用：> 或 >空格 开头，逐行成区（相邻引用行各自独立，命中互不影响）---
  {
    type: 'blockquote',
    match: (line) => line.match(/^(>\s?)(.*)$/),
    parseInline: true,
    buildRegion({ lineStart, lineEnd, match }) {
      const markLen = match[1].length
      return {
        from: lineStart,
        to: lineEnd,
        contentFrom: lineStart + markLen,
        contentTo: lineEnd,
        meta: { markFrom: lineStart, markTo: lineStart + markLen },
        render: {
          // 整行（含标记）套用引用样式；标记未命中时隐藏、命中时弱化显示
          contentClass: 'md-blockquote',
          contentRange: { from: lineStart, to: lineEnd },
          markerActiveClass: 'md-syntax-visible',
          markers: [{ from: lineStart, to: lineStart + markLen }]
        }
      }
    }
  }
]
