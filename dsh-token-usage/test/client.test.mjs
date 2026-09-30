// Exercise the shipped client component without installing React or a browser.
// Run: node test/client.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const match = find(child, predicate)
    if (match) return match
  }
}

async function mount(data) {
  const states = []
  const effects = []
  let cursor = 0
  let component
  let plugin
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (value) => { states[index] = value }]
    },
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: () => ({ current: null }),
    useEffect: (effect) => { effects.push(effect) },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React) } } },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, data }) }),
  })
  plugin.apply({
    locale: { bind: () => undefined },
    effect(setup, label) { if (label.endsWith('settings section')) setup() },
    slots: { inject: (_, setup) => setup(), register: (_, value) => { component = value } },
  })
  const render = () => { cursor = 0; return component({}) }
  render()
  effects[0]() // Load the fixture through the component's normal fetch path.
  await new Promise((resolve) => setImmediate(resolve))
  return {
    render,
    select(key) {
      const button = find(render(), (node) => node.type === 'button' && node.props.key === key)
      assert.ok(button, `button ${key} exists`)
      button.props.onClick()
    },
  }
}

for (const range of [3, 6, 12]) {
  // A full week includes Sunday, which must behave identically to other weekdays.
  for (let weekday = 0; weekday < 7; weekday++) {
    for (const currentTokens of [0, 10, 700]) {
      test(`${range}M weekday ${weekday}, current week ${currentTokens} tokens`, async () => {
        const today = `2026-09-${String(21 + weekday).padStart(2, '0')}`
        const days = [{ d: '2026-09-14', a: 700 }]
        if (currentTokens) days.push({ d: today, a: currentTokens })
        const ui = await mount({ today, days, totals: { all: 700 + currentTokens } })
        ui.select(range)
        for (const tab of ['weekly', 'cum', 'daily']) {
          ui.select(tab)
          const grid = find(ui.render(), (node) => node.props.className === 'dthm-grid')
          const lastColumn = grid.children.slice(-7)
          assert.equal(lastColumn.length, 7)
          const visible = lastColumn.filter((cell) => cell.props.style?.background)
          assert.equal(visible.length, tab === 'daily' ? weekday + 1 : 7,
            `${tab}: complete aggregate column, daily stops at today`)
          for (const cell of lastColumn) {
            assert.equal(typeof cell.props.onMouseEnter === 'function',
              tab !== 'daily' || cell.props.key <= today, `${tab}: hover follows cell visibility`)
          }
          if (tab !== 'daily') {
            const lit = lastColumn.filter((cell) => cell.props.style?.background === '#60b2ff')
            const expected = tab === 'weekly' ? (currentTokens === 0 ? 0 : currentTokens === 10 ? 1 : 7)
              : (currentTokens === 0 ? 1 : 2)
            assert.equal(lit.length, expected, `${tab}: token mapping determines colored cells`)
            assert.ok(lastColumn.slice(7 - expected).every((cell) => cell.props.style.background === '#60b2ff'),
              `${tab}: colored cells stack from the bottom`)
          }
        }
      })
    }
  }
}
