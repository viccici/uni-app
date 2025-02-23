import path from 'path'
import type { Plugin, ResolvedConfig } from 'vite'

import type { OutputChunk } from 'rollup'

import {
  isSsr,
  parseRpx2UnitOnce,
  resolveBuiltIn,
} from '@dcloudio/uni-cli-shared'

import {
  generateSsrDefineCode,
  generateSsrEntryServerCode,
  initSsrAliasOnce,
  initSsrDefine,
  rewriteSsrNativeTag,
  rewriteSsrRenderStyle,
  rewriteSsrVue,
} from '../utils'

const ENTRY_SERVER_JS = 'entry-server.js'

export function uniSSRPlugin(): Plugin {
  let entryServerJs: string
  let resolvedConfig: ResolvedConfig
  const entryServerJsCode = generateSsrEntryServerCode()
  return {
    name: 'uni:h5-ssr',
    config(userConfig, env) {
      if (isSsr(env.command, userConfig)) {
        initSsrAliasOnce()
        rewriteSsrVue()
        rewriteSsrNativeTag()
        rewriteSsrRenderStyle(process.env.UNI_INPUT_DIR)
        return {
          resolve: {
            alias: [
              {
                find: 'vue/server-renderer',
                replacement: resolveBuiltIn('@vue/server-renderer'),
              },
              {
                find: 'vue',
                replacement: resolveBuiltIn(
                  '@dcloudio/uni-h5-vue/' +
                    (process.env.UNI_APP_X === 'true' ? 'dist-x' : 'dist') +
                    '/vue.runtime.esm.js'
                ),
              },
            ],
          },
        }
      }
    },
    configResolved(config: ResolvedConfig) {
      resolvedConfig = config
      entryServerJs = path.join(process.env.UNI_INPUT_DIR, ENTRY_SERVER_JS)
      if (isSsr(resolvedConfig.command, resolvedConfig)) {
        initSsrDefine(resolvedConfig)
      }
    },
    resolveId(id) {
      if (id.endsWith(ENTRY_SERVER_JS)) {
        return entryServerJs
      }
    },
    load(id) {
      if (id.endsWith(ENTRY_SERVER_JS)) {
        return entryServerJsCode
      }
    },
    generateBundle(_options, bundle) {
      const chunk = bundle['entry-server.js'] as OutputChunk
      if (chunk) {
        chunk.code =
          generateSsrDefineCode(
            resolvedConfig,
            parseRpx2UnitOnce(
              process.env.UNI_INPUT_DIR,
              process.env.UNI_PLATFORM
            )
          ) +
          '\n' +
          chunk.code
      }
    },
  }
}
