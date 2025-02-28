import { initPropsObserver } from './util'

const MPComponent = Component

Component = function (options: tinyapp.ComponentOptions) {
  // 小程序组件
  const isVueComponent =
    options.props && typeof options.props.uP !== 'undefined'
  if (!isVueComponent) {
    initPropsObserver(options)
  }
  return MPComponent(options)
}
