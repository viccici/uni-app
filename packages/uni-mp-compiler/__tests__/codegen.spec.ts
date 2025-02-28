import { assert } from './testUtils'

describe('compiler: codegen', () => {
  test('module mode preamble', () => {
    assert(
      `<view v-for="item in items" @click="onClick"></view>`,
      `<view wx:for="{{a}}" wx:for-item="item" bindtap="{{b}}"></view>`,
      `import { o as _o, f as _f } from "vue"

export function render(_ctx, _cache) {
  return { a: _f(_ctx.items, (item, k0, i0) => { return {}; }), b: _o(_ctx.onClick) }
}`,
      { inline: false, mode: 'module', prefixIdentifiers: false }
    )
  })

  test('module mode preamble w/ optimizeImports: true', () => {
    assert(
      `<view v-for="item in items" @click="onClick"></view>`,
      `<view wx:for="{{a}}" wx:for-item="item" bindtap="{{b}}"></view>`,
      `import { o as _o, f as _f } from "vue"

export function render(_ctx, _cache) {
  return { a: _f(_ctx.items, (item, k0, i0) => { return {}; }), b: _o(_ctx.onClick) }
}`,
      { inline: false, mode: 'module' }
    )
  })

  test('function mode preamble', () => {
    assert(
      `<view v-for="item in items" @click="onClick"></view>`,
      `<view wx:for="{{a}}" wx:for-item="item" bindtap="{{b}}"></view>`,
      `const _Vue = Vue

return function render(_ctx, _cache) {
  with (_ctx) {
    const { o: _o, f: _f } = _Vue

    return { a: _f(items, (item, k0, i0) => { return {}; }), b: _o(onClick) }
  }
}`,
      { inline: false, mode: 'function', prefixIdentifiers: false }
    )
  })
  test('function mode preamble w/ prefixIdentifiers: true', () => {
    assert(
      `<view v-for="item in items" @click="onClick"></view>`,
      `<view wx:for="{{a}}" wx:for-item="item" bindtap="{{b}}"></view>`,
      `const { o: _o, f: _f } = Vue

return function render(_ctx, _cache) {
  return { a: _f(_ctx.items, (item, k0, i0) => { return {}; }), b: _o(_ctx.onClick) }
}`,
      { inline: false, mode: 'function' }
    )
  })
  test('static text', () => {
    assert(
      `hello`,
      `hello`,
      `(_ctx, _cache) => {
  return {}
}`
    )
  })
  test('interpolation', () => {
    assert(
      `{{hello}}`,
      `{{a}}`,
      `(_ctx, _cache) => {
  return { a: _t(_ctx.hello) }
}`
    )
  })
  test('comment', () => {
    assert(
      `<!--foo-->`,
      ``,
      `(_ctx, _cache) => {
  return {}
}`
    )
  })
  test('compound expression', () => {
    assert(
      `{{foo}}{{bar}}nested`,
      `{{a}}{{b}}nested`,
      `(_ctx, _cache) => {
  return { a: _t(_ctx.foo), b: _t(_ctx.bar) }
}`
    )
  })
})
