import {
  ViewPlugin,
  Decoration,
  WidgetType
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { parseMarkdownRegions, regionHitsLineRanges } from './markdown-parser'

/**
 * 块级结构的渲染模型（标题/引用/围栏/分割线…）统一为两种东西：
 * 1. Widget：未命中光标时整体替换区域（见 WIDGETS）
 * 2. 样式指令 render（contentClass / lineClass / markers / hideLines…）：
 *    由 {@link applyBlockRender} 统一映射为 CodeMirror decorations。
 * 行内结构（粗体/斜体/链接等）与列表仍在本文件按各自规则处理。
 */

/**
 * HR Widget — renders a horizontal rule
 */
class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr')
    hr.className = 'md-hr'
    return hr
  }
  ignoreEvent() { return false }
}

/**
 * Image Widget — renders an image preview
 */
class ImageWidget extends WidgetType {
  constructor(alt, url) {
    super()
    this.alt = alt
    this.url = url
  }

  /**
   * 检测是否为本地文件系统路径
   */
  isLocalPath(path) {
    if (!path) return false
    // Windows: C:\, D:\, \\network\path
    if (/^[a-zA-Z]:\\/.test(path) || path.startsWith('\\\\')) return true
    // Unix/Mac: /absolute/path or ~/home/path or file://
    if (path.startsWith('file://') || (path.startsWith('/') && !path.startsWith('//'))) return true
    // Relative paths: ./path or ../path
    if (path.startsWith('./') || path.startsWith('../')) return true
    return false
  }

  /**
   * 检测是否为网络路径
   */
  isNetworkPath(path) {
    if (!path) return false
    return /^https?:\/\//i.test(path) || path.startsWith('//')
  }

  toDOM() {
    const wrapper = document.createElement('span')
    wrapper.className = 'md-image-placeholder'

    // 检查是否为网络路径
    if (this.isNetworkPath(this.url)) {
      const img = document.createElement('img')
      img.src = this.url
      img.alt = this.alt || ''
      img.className = 'md-image-widget'
      img.style.maxWidth = '100%'
      img.onerror = () => {
        wrapper.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span>图片加载失败: ${this.alt || this.url}</span>
          </div>
        `
        wrapper.className = 'md-image-placeholder'
      }
      wrapper.textContent = ''
      wrapper.className = ''
      wrapper.appendChild(img)
    }
    // 检查是否为本地文件系统路径
    else if (this.isLocalPath(this.url)) {
      wrapper.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>浏览器无法访问本地路径: ${this.url}</span>
          </div>
          <span style="font-size: 11px; opacity: 0.7;">提示：请使用 http:// 或 https:// 开头的网络图片地址</span>
        </div>
      `
    }
    // 其他情况（可能是相对路径或无效路径）
    else {
      wrapper.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <span>${this.alt || '图片'}: ${this.url || '未指定路径'}</span>
        </div>
      `
    }
    return wrapper
  }
  ignoreEvent() { return false }
  eq(other) { return other.url === this.url && other.alt === this.alt }
}

/**
 * Checkbox Widget for task lists
 */
class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super()
    this.checked = checked
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = `md-task-checkbox${this.checked ? ' md-task-checkbox--checked' : ''}`
    if (!this.checked) {
      span.innerHTML = '&nbsp;'
    }
    return span
  }
  ignoreEvent() { return false }
  eq(other) { return other.checked === this.checked }
}

/**
 * 块级 widget 登记表：与 block-structures.js 中 render.widget 标识一一对应。
 * 新增需要整体替换为 widget 的块级结构时，在此处追加一个工厂即可。
 */
const WIDGETS = {
  hr: () => new HrWidget()
}

// Decoration marks
const boldDeco = Decoration.mark({ class: 'md-bold' })
const italicDeco = Decoration.mark({ class: 'md-italic' })
const strikeDeco = Decoration.mark({ class: 'md-strikethrough' })
const inlineCodeDeco = Decoration.mark({ class: 'md-inline-code' })
const linkDeco = Decoration.mark({ class: 'md-link' })
const listMarkerDeco = Decoration.mark({ class: 'md-list-marker' })
const syntaxHiddenDeco = Decoration.mark({ class: 'md-syntax-hidden' })
const syntaxVisibleDeco = Decoration.mark({ class: 'md-syntax-visible' })

/**
 * Get the line range that the cursor is on.
 * Returns { from, to } of the current line(s) covered by all selections.
 */
function getCursorLineRanges(state) {
  const ranges = []
  for (const sel of state.selection.ranges) {
    const lineFrom = state.doc.lineAt(sel.from)
    const lineTo = state.doc.lineAt(sel.to)
    ranges.push({ from: lineFrom.from, to: lineTo.to })
  }
  return ranges
}

/**
 * Apply one block region's unified render directive.
 *
 * 所有块级结构共用这一套边界 → decoration 的映射，命中判定也共用
 * regionHitsLineRanges；本函数不关心 region.type，只消费 render 指令。
 *
 * @param {MarkdownRegion} region
 * @param {boolean} cursorOn - 光标所在行是否与区域相交
 * @param {EditorState} state
 * @param {Array} decos - 收集 { from, to, deco, isLine }
 */
function applyBlockRender(region, cursorOn, state, decos) {
  const render = region.render
  if (!render) return

  // 未命中且声明了整体 widget：整块替换，其余指令不再生效
  if (render.widget && !cursorOn) {
    decos.push({
      from: region.from,
      to: region.to,
      deco: Decoration.replace({ widget: WIDGETS[render.widget]() })
    })
    return
  }

  // 常驻内容样式（范围默认 contentFrom..contentTo，可用 contentRange 覆盖）
  if (render.contentClass) {
    const range = render.contentRange || { from: region.contentFrom, to: region.contentTo }
    decos.push({ from: range.from, to: range.to, deco: Decoration.mark({ class: render.contentClass }) })
  }

  // 行样式：区域覆盖的每一行各生成一个 line decoration
  if (render.lineClass) {
    const lineDeco = Decoration.line({ class: render.lineClass })
    const startLine = state.doc.lineAt(region.from)
    const endLine = state.doc.lineAt(region.to)
    for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
      const lineFrom = state.doc.line(lineNum).from
      decos.push({ from: lineFrom, to: lineFrom, deco: lineDeco, isLine: true })
    }
  }

  if (render.hideLines && Array.isArray(render.markerLines)) {
    // 围栏型：未命中时整体隐藏开/闭标记行；命中时恢复原始语法（不装饰）
    if (!cursorOn) {
      for (const markerLine of render.markerLines) {
        decos.push({ from: markerLine.from, to: markerLine.to, deco: syntaxHiddenDeco })
      }
    }
    return
  }

  // 语法标记：未命中隐藏；命中使用结构声明的弱化样式（缺省 md-syntax-visible）
  if (Array.isArray(render.markers)) {
    const activeDeco = render.markerActiveClass
      ? Decoration.mark({ class: render.markerActiveClass })
      : syntaxVisibleDeco
    for (const marker of render.markers) {
      decos.push({ from: marker.from, to: marker.to, deco: cursorOn ? activeDeco : syntaxHiddenDeco })
    }
  }
}

/**
 * Build decorations for the entire document.
 * Core logic: if cursor is on a region, show syntax marks; otherwise, hide them and show rendered result.
 */
function buildDecorations(state) {
  const doc = state.doc.toString()
  const regions = parseMarkdownRegions(doc)
  const cursorRanges = getCursorLineRanges(state)
  const builder = new RangeSetBuilder()

  // We need to collect all decorations and sort them by from position
  const decos = []

  for (const region of regions) {
    const cursorOn = regionHitsLineRanges(region, cursorRanges)

    // 带统一 render 指令的块级结构（heading / hr / blockquote / code-block）
    if (region.render) {
      applyBlockRender(region, cursorOn, state, decos)
      continue
    }

    switch (region.type) {
      case 'bold': {
        // Apply bold to content
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: boldDeco })
        if (!cursorOn) {
          // Hide markers
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'italic': {
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: italicDeco })
        if (!cursorOn) {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'strikethrough': {
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: strikeDeco })
        if (!cursorOn) {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'inline-code': {
        decos.push({ from: region.contentFrom, to: region.contentTo, deco: inlineCodeDeco })
        if (!cursorOn) {
          const markerLen = region.meta.markerLen
          decos.push({ from: region.from, to: region.from + markerLen, deco: syntaxHiddenDeco })
          decos.push({ from: region.to - markerLen, to: region.to, deco: syntaxHiddenDeco })
        } else {
          const markerLen = region.meta.markerLen
          decos.push({ from: region.from, to: region.from + markerLen, deco: syntaxVisibleDeco })
          decos.push({ from: region.to - markerLen, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'link': {
        if (!cursorOn) {
          // Show only the link text with link styling
          decos.push({ from: region.contentFrom, to: region.contentTo, deco: linkDeco })
          // Hide [
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxHiddenDeco })
          // Hide ](url)
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxHiddenDeco })
        } else {
          decos.push({ from: region.contentFrom, to: region.contentTo, deco: linkDeco })
          decos.push({ from: region.from, to: region.contentFrom, deco: syntaxVisibleDeco })
          decos.push({ from: region.contentTo, to: region.to, deco: syntaxVisibleDeco })
        }
        break
      }

      case 'image': {
        if (!cursorOn) {
          // Replace the entire image syntax with a widget
          decos.push({
            from: region.from,
            to: region.to,
            deco: Decoration.replace({
              widget: new ImageWidget(region.meta.alt, region.meta.url)
            })
          })
        }
        // When cursor is on it, show raw syntax (no decoration needed)
        break
      }

      case 'list-bullet': {
        const { markerFrom, markerTo } = region.meta
        decos.push({ from: markerFrom, to: markerTo, deco: listMarkerDeco })
        break
      }

      case 'list-ordered': {
        const { markerFrom, markerTo } = region.meta
        decos.push({ from: markerFrom, to: markerTo, deco: listMarkerDeco })
        break
      }

      case 'task-list': {
        if (!cursorOn) {
          const { checkFrom, checkTo, checked } = region.meta
          decos.push({
            from: checkFrom,
            to: checkTo + 1,
            deco: Decoration.replace({
              widget: new CheckboxWidget(checked)
            })
          })
        }
        break
      }
    }
  }

  // Sort decorations by from position, then by whether they are line decorations
  decos.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    // Line decorations should come before mark decorations at the same position
    if (a.isLine && !b.isLine) return -1
    if (!a.isLine && b.isLine) return 1
    return 0
  })

  // Filter out invalid ranges (from >= to for non-line decorations)
  for (const d of decos) {
    if (d.isLine) {
      builder.add(d.from, d.from, d.deco)
    } else if (d.from < d.to) {
      builder.add(d.from, d.to, d.deco)
    }
  }

  return builder.finish()
}

/**
 * The main ViewPlugin that drives live markdown rendering.
 */
export const markdownDecorationPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view.state)
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.state)
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
)

// Exposed for tooling/tests: pure decoration builder driven by editor state.
export { buildDecorations }
