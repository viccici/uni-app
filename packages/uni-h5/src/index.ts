//#if _X_
import '@dcloudio/uni-uts-v1/lib/javascript/lib/runtime/uts.js'
//#endif

export {
  Button,
  Canvas,
  Checkbox,
  CheckboxGroup,
  Editor,
  Form,
  Icon,
  Image,
  Input,
  Label,
  MovableArea,
  MovableView,
  Navigator,
  PickerView,
  PickerViewColumn,
  Progress,
  Radio,
  RadioGroup,
  ResizeSensor,
  RichText,
  ScrollView,
  Slider,
  Swiper,
  SwiperItem,
  Switch,
  Text,
  Textarea,
  View,
  //#if _X_
  ListView,
  ListItem,
  StickySection,
  StickyHeader,
  UniElement,
  UniElement as UniElementImpl,
  UniButtonElement,
  UniCanvasElement,
  UniCheckboxElement,
  UniCheckboxGroupElement,
  UniEditorElement,
  UniFormElement,
  UniIconElement,
  UniImageElement,
  UniInputElement,
  UniLabelElement,
  UniMovableAreaElement,
  UniMovableViewElement,
  UniNavigatorElement,
  UniPickerViewElement,
  UniPickerViewColumnElement,
  UniProgressElement,
  UniRadioElement,
  UniRadioGroupElement,
  UniRichTextElement,
  UniScrollViewElement,
  UniSliderElement,
  UniSwiperElement,
  UniSwiperItemElement,
  UniSwitchElement,
  UniTextElement,
  UniTextareaElement,
  UniViewElement,
  UniListViewElement,
  UniListItemElement,
  UniStickySectionElement,
  UniStickyHeaderElement,
  //#endif
} from '@dcloudio/uni-components'

export { useI18n } from '@dcloudio/uni-core'

export { default as plugin } from './framework/plugin'

export * from './framework/setup'

export * from './view/components'

export * from './view/bridge'

export * from './service/api'
export * from './service/api/uni'
export * from './service/bridge'

export { getApp, getCurrentPages } from './framework'

export { default as LayoutComponent } from './framework/components/layout/index'
export { default as PageComponent } from './framework/components/page/index'
export { default as AsyncErrorComponent } from './framework/components/async-error/index'
export { default as AsyncLoadingComponent } from './framework/components/async-loading'
export * from './framework/setup/state'
export { getRealPath } from './platform'
