/**
 * 工作流工具栏按钮尺寸契约测试 —— 零新增依赖。
 *
 * 背景（用户反馈）：「工作流页面，运行旁边的查看器按钮优化一下，它在中间比两边的
 * 都要大看着不协调」。
 *
 * 根因有两层：
 *   1. `.primary` / `.ghost`（shell.css）是**颜色修饰类**——故意不带尺寸，好在弹窗等
 *      基础尺寸的按钮上复用。单独放进工具栏时就回落到 `button` 的 8px/14px/13px，
 *      比邻居的 6px/12px 高出一圈。「查看器」与暂停态的「继续」都栽在这里。
 *   2. 就算尺寸拉齐，还有两处 2px 的差：`.primary` 无边框（基础 `button { border: none }`
 *      没被补回来），纯图标的 `.wf-tool-btn` 内容盒只有 14px（svg）而带文字的按钮是
 *      16px 行盒。一行三个按钮能凑出三种高度。
 *
 * 修法是 workflows.css 里一条作用域规则 `.wf-toolbar__actions > button`：
 *   凡放进工具栏的按钮，一律按工具栏尺寸渲染（纵向 padding / font-size / line-height /
 *   min-height）。min-height 就是用来兜住那两处 2px 的。
 *
 * 真实布局量测要引擎才准（见 `.workbuddy/_shot_toolbar_actions.cjs` 的 Electron 实测：
 * 改前极差 7px / 3px → 改后 0px）。本文件守的是**布局赖以成立的契约**：那几条 CSS
 * 声明不许被悄悄改掉，工具栏的结构也不许被换掉而不自知。
 *
 * 运行：`npm run test:toolbar`（已接入 `npm test`）。
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const WORKFLOWS_CSS = read('src/styles/workflows.css')
const SHELL_CSS = read('src/styles/shell.css')
const WORKFLOWS_PAGE = read('src/pages/WorkflowsPage.tsx')

// ─── 极简 CSS 解析：够用即可（这三个文件只有顶层规则 + @keyframes/@media）────────

/** 剔除注释：本仓库样式注释较长且含 `>`、`;`，不先去掉会污染选择器/声明解析。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** 选择器归一化：折叠空白，让 `.a>.b` 与 `.a > .b` 视为同一个。 */
const normSelector = (s) => s.replace(/\s+/g, ' ').replace(/\s*>\s*/g, ' > ').trim()

/** 抽顶层规则 → [{ selector, body }]；at-rule 块（@keyframes/@media）整体跳过。 */
function topLevelRules(rawCss) {
  const css = stripComments(rawCss)
  const rules = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const selector = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    if (selector && !selector.startsWith('@')) {
      rules.push({ selector: normSelector(selector), body: css.slice(open + 1, j - 1) })
    }
    i = j
  }
  return rules
}

/** 声明体 → Map<属性, 值>（小写属性名，值去空白；忽略 `!important`）。 */
function decls(body) {
  const map = new Map()
  for (const part of body.split(';')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const prop = part.slice(0, idx).trim().toLowerCase()
    if (!prop) continue
    map.set(prop, part.slice(idx + 1).replace(/!important/gi, '').trim())
  }
  return map
}

/** 找出选择器完全匹配的最后一条规则（层叠里后写覆盖先写），没有则返回 null。 */
const findRule = (rules, selector) => {
  const hit = rules.filter((r) => r.selector === selector)
  return hit.length ? hit[hit.length - 1] : null
}

const px = (value, what) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? ''))
  assert.ok(m, `${what} 必须是 px 数值，实际是「${value}」`)
  return Number(m[1])
}

const RESULTS = []
function test(name, fn) {
  try {
    fn()
    RESULTS.push([name, true, ''])
    console.log(`PASS ${name}`)
  } catch (e) {
    RESULTS.push([name, false, `${e.name}: ${e.message}`])
    console.log(`FAIL ${name}: ${e.name}: ${e.message}`)
  }
}

// ─── 解析出工具栏的尺寸契约 ───────────────────────────────────────────────────

const wfRules = topLevelRules(WORKFLOWS_CSS)
const shellRules = topLevelRules(SHELL_CSS)

const SCOPE_SELECTOR = '.wf-toolbar__actions > button'
const scopeRule = findRule(wfRules, SCOPE_SELECTOR)
const scope = scopeRule ? decls(scopeRule.body) : new Map()

/** 工具栏里出现过的按钮类（含颜色修饰类），每个都要算一遍盒高。 */
const TOOLBAR_CLASSES = ['wf-run-btn', 'wf-stop-btn', 'wf-tool-btn', 'ghost', 'primary']

/**
 * 复刻浏览器的高度轴算法：自然高 = 纵向上边距 + 上下边框 + 行盒；
 * 最终高 = max(自然高, min-height)（`box-sizing: border-box`，见 shell.css 的 `*`）。
 *
 * 行盒取的是**文字**的高度：纯图标按钮的 svg（14px）比 16px 行盒矮，不影响结果。
 */
function boxHeight(className) {
  const rule = findRule(wfRules, `.${className}`) || findRule(shellRules, `.${className}`)
  const d = rule ? decls(rule.body) : new Map()

  // 纵向 padding：作用域规则优先（同名属性后写覆盖），其次按钮自己的规则。
  const paddingTop = scope.has('padding-top')
    ? px(scope.get('padding-top'), `${SCOPE_SELECTOR} 的 padding-top`)
    : px(d.get('padding-top') ?? '0px', `.${className} 的 padding-top`)
  const paddingBottom = scope.has('padding-bottom')
    ? px(scope.get('padding-bottom'), `${SCOPE_SELECTOR} 的 padding-bottom`)
    : px(d.get('padding-bottom') ?? '0px', `.${className} 的 padding-bottom`)

  // 边框：基础 `button { border: none }` → `.primary` 不补边框，天生比兄弟矮 2px。
  const base = findRule(shellRules, 'button')
  const baseBorder = decls(base ? base.body : '').get('border')
  const ownBorder = d.get('border')
  const borderTop = ownBorder
    ? px((/^(\S+)/.exec(ownBorder) || [])[1], `.${className} 的 border 宽度`)
    : baseBorder === 'none'
      ? 0
      : 0

  const lineHeight = px(scope.get('line-height'), `${SCOPE_SELECTOR} 的 line-height`)
  const minHeight = pixOrNull(scope.get('min-height'))
  const natural = paddingTop + paddingBottom + borderTop * 2 + lineHeight
  return { natural, minHeight, height: minHeight === null ? natural : Math.max(natural, minHeight) }
}

function pixOrNull(value) {
  if (value === undefined) return null
  return px(value, `${SCOPE_SELECTOR} 的 min-height`)
}

// ─── 用例 ─────────────────────────────────────────────────────────────────────

test('工具栏作用域尺寸规则存在，且挂在 .wf-toolbar__actions 之下', () => {
  assert.ok(
    scopeRule,
    `workflows.css 缺少 \`${SCOPE_SELECTOR}\` 规则——没有它，.ghost / .primary 会回落到\n` +
      '基础 button 的 8px/14px/13px，比邻居高出一圈（用户反馈的「中间那个比两边都大」）'
  )
  assert.equal(
    scopeRule.selector,
    SCOPE_SELECTOR,
    '选择器必须精确限定在工具栏内；写成裸 button 会污染弹窗等基础尺寸按钮'
  )
})

test('契约声明齐全：纵向 padding / font-size / line-height / min-height', () => {
  for (const prop of ['padding-top', 'padding-bottom', 'font-size', 'line-height', 'min-height']) {
    assert.ok(scope.has(prop), `${SCOPE_SELECTOR} 缺少 ${prop}——少任何一条都会有按钮掉队`)
  }
  assert.equal(px(scope.get('font-size'), 'font-size'), 12, '工具栏字号应为 12px（与兄弟按钮一致）')
  assert.equal(px(scope.get('line-height'), 'line-height'), 16, '工具栏行盒应为 16px')
  // 横向 padding 由各按钮自己定（文字宽度不同），作用域规则不该插手。
  assert.ok(
    !scope.has('padding-left') && !scope.has('padding-right') && !scope.has('padding'),
    '作用域规则不应设置横向 padding，否则会压掉 .wf-run-btn / .wf-stop-btn 自己的 16px'
  )
})

test('工具栏五种按钮算出的高度完全一致（含无边框与纯图标两种短板）', () => {
  const heights = TOOLBAR_CLASSES.map((c) => ({ c, ...boxHeight(c) }))
  const detail = heights
    .map((h) => `  .${h.c}: 自然高 ${h.natural}px → 最终 ${h.height}px`)
    .join('\n')
  const set = new Set(heights.map((h) => h.height))
  assert.equal(
    set.size,
    1,
    `工具栏按钮高度不齐（用户反馈的症状）：\n${detail}\n` +
      'min-height 用来兜住比同类矮一截的按钮——最容易漏的就是无边框的 .primary（少 2px 边框）'
  )
  assert.ok(heights[0].height >= 26, `工具栏按钮高度 ${heights[0].height}px 偏小，可能被改坏了`)
})

test('shell.css 的颜色修饰类不携带尺寸（它们要在弹窗里复用基础尺寸）', () => {
  for (const cls of ['primary', 'ghost']) {
    const rule = findRule(shellRules, `.${cls}`)
    assert.ok(rule, `shell.css 缺少 .${cls}`)
    const d = decls(rule.body)
    for (const prop of ['padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'font-size', 'height', 'min-height', 'line-height']) {
      assert.ok(
        !d.has(prop),
        `.${cls} 声明了 ${prop} —— 它是颜色修饰类，尺寸要留给使用处决定。\n` +
          '工具栏的尺寸问题应改 workflows.css 的 `.wf-toolbar__actions > button`，不要动这里'
      )
    }
  }
})

test('工具栏结构未变形：查看器仍是 .ghost，继续仍是 .primary', () => {
  const blocks = WORKFLOWS_PAGE.match(/className="wf-toolbar__actions"/g) || []
  assert.equal(blocks.length, 1, `WorkflowsPage 应只有一处 .wf-toolbar__actions，实际 ${blocks.length} 处`)

  const start = WORKFLOWS_PAGE.indexOf('className="wf-toolbar__actions"')
  const end = WORKFLOWS_PAGE.indexOf('</div>', start)
  const toolbar = WORKFLOWS_PAGE.slice(start, end === -1 ? WORKFLOWS_PAGE.length : end)

  // 用 i18n key 定位两个按钮：键名比中文文案稳定。
  assert.ok(
    /<button className="ghost"[\s\S]{0,200}?workflows\.toolbar\.viewerTitle/.test(toolbar),
    '「查看器」应保持 .ghost（靠配色区别于「运行」，高度由作用域规则统一）'
  )
  assert.ok(
    /<button className="primary"[\s\S]{0,200}?workflows\.toolbar\.(continue|resume)/.test(toolbar),
    '暂停态的「继续」应保持 .primary'
  )

  const known = new Set(TOOLBAR_CLASSES)
  for (const m of toolbar.matchAll(/<button className="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) {
      assert.ok(
        known.has(cls),
        `工具栏里出现了未纳入契约的按钮类 .${cls} —— 若确要新增，请同步更新本测试的 TOOLBAR_CLASSES`
      )
    }
  }
})

// ─── 汇总 ─────────────────────────────────────────────────────────────────────

const failed = RESULTS.filter(([, ok]) => !ok)
console.log(`\n${RESULTS.length - failed.length}/${RESULTS.length} passed`)
process.exit(failed.length ? 1 : 0)
