import os from 'os'
import fs from 'fs-extra'
import path, { join } from 'path'
import AdmZip from 'adm-zip'
import { sync } from 'fast-glob'
import { hasOwn, isArray } from '@vue/shared'
import type {
  UTSBundleOptions,
  UTSInputOptions,
  UTSOutputOptions,
  UTSResult,
} from '@dcloudio/uts'
import { get } from 'android-versions'
import { normalizePath, parseJson, resolveSourceMapPath } from './shared'
import {
  type CompilerServer,
  type ToKotlinOptions,
  genComponentsCode,
  genUTSPlatformResource,
  getCompilerServer,
  getUTSCompiler,
  isColorSupported,
  isUniCloudSupported,
  moveRootIndexSourceMap,
  parseExtApiDefaultParameters,
  parseInjectModules,
  parseKotlinPackageWithPluginId,
  resolveAndroidDir,
  resolveConfigProvider,
  resolvePackage,
  resolveSourceMapFile,
  resolveUTSPlatformFile,
  resolveUTSSourceMapPath,
} from './utils'
import type { Module } from '../types/types'
import { parseUTSKotlinStacktrace, parseUTSSyntaxError } from './stacktrace'
import type { APP_PLATFORM } from './manifest/utils'
import { restoreDex } from './manifest'
import {
  type MessageSourceLocation,
  hbuilderFormatter,
} from './stacktrace/kotlin'

export interface KotlinCompilerServer extends CompilerServer {
  getKotlincHome(): string
  getDefaultJar(arg?: any): string[]
  compile(
    options: {
      kotlinc: string[]
      d8: string[]
      stderrListener: (data: string) => void
      pageCount: number
    },
    projectPath: string
  ): Promise<{ code: number; msg: string; data?: { dexList: string[] } }>
  checkDependencies?: (
    configJsonPath: string,
    options?: { type: 1 /*插件*/ | 2 /*项目*/; valid: boolean }
  ) => Promise<{ code: number; msg: string; data: string[] }>
  checkRResources?: (resDir: string) => Promise<{
    code: number
    msg: string
    data: { jarPath: string; uniModuleName: string }
  }>
}

export function createKotlinResolveTypeReferenceName(
  _namespace: string,
  _ast: Module
) {
  return (name: string) => name
}

function parseKotlinPackage(filename: string) {
  const res = resolvePackage(filename)
  if (!res) {
    return { id: '', package: '' }
  }
  return {
    id: res.id,
    package: parseKotlinPackageWithPluginId(res.name, res.is_uni_modules),
  }
}

const pluginInjectApis = new Set<string>()

function addInjectApis(apis: string[]) {
  apis.forEach((api) => {
    pluginInjectApis.add(api)
  })
}

export function getInjectApis() {
  return [...pluginInjectApis]
}

export async function runKotlinProd(
  filename: string,
  components: Record<string, string>,
  {
    pluginId,
    isPlugin,
    isX,
    isSingleThread,
    hookClass,
    extApis,
    transform,
    sourceMap,
    uniModules,
  }: {
    pluginId: string
    isPlugin: boolean
    isX: boolean
    isSingleThread: boolean
    hookClass: string
    extApis?: Record<string, [string, string]>
    transform?: UTSOutputOptions['transform']
    sourceMap?: boolean
    uniModules: string[]
  }
) {
  // 文件有可能是 app-ios 里边的，因为编译到 android 时，为了保证不报错，可能会去读取 ios 下的 uts
  if (filename.includes('app-ios')) {
    return
  }
  const inputDir = process.env.UNI_INPUT_DIR
  const outputDir = process.env.UNI_OUTPUT_DIR
  const result = await compile(filename, {
    inputDir,
    outputDir,
    sourceMap: !!sourceMap,
    components,
    isX,
    isSingleThread,
    isPlugin,
    extApis,
    transform,
    uniModules,
  })
  if (!result) {
    return
  }
  if (result.error) {
    throw parseUTSSyntaxError(result.error, inputDir)
  }

  if (result.inject_apis && result.inject_apis.length) {
    if (isX && process.env.UNI_UTS_COMPILER_TYPE === 'cloud') {
      updateManifestModules(inputDir, result.inject_apis)
    } else {
      addInjectApis(result.inject_apis)
    }
  }

  genUTSPlatformResource(filename, {
    isX,
    pluginId,
    inputDir,
    outputDir,
    platform: 'app-android',
    extname: '.kt',
    components,
    package: parseKotlinPackage(filename).package + '.',
    hookClass,
    result,
    provider: resolveConfigProvider('app-android', pluginId, transform),
    uniModules,
  })

  return result
}

function updateManifestModules(inputDir: string, inject_apis: string[]) {
  const filename = path.resolve(inputDir, 'manifest.json')
  if (fs.existsSync(filename)) {
    const content = fs.readFileSync(filename, 'utf8')
    try {
      const json = JSON.parse(content)
      if (!json.app) {
        json.app = {}
      }
      if (!json.app.distribute) {
        json.app.distribute = {}
      }
      if (!json.app.distribute.modules) {
        json.app.distribute.modules = {}
      }
      const modules = json.app.distribute.modules
      let updated = false
      parseInjectModules(inject_apis, {}, []).forEach((name) => {
        if (!hasOwn(modules, name)) {
          modules[name] = {}
          updated = true
        }
      })
      if (updated) {
        fs.outputFileSync(filename, JSON.stringify(json, null, 2))
      }
    } catch (e) {}
  }
}

export type RunKotlinDevResult = UTSResult & {
  type: 'kotlin'
  changed: string[]
  inject_modules: string[]
  kotlinc: boolean
  kotlincJars?: string[]
}

export type RunKotlinBuildResult = UTSResult & {
  type: 'kotlin'
  inject_modules: string[]
  kotlinc: false
}

interface RunKotlinDevOptions {
  components: Record<string, string>
  isX: boolean
  isSingleThread: boolean
  isPlugin: boolean
  sourceMap: boolean
  cacheDir: string
  pluginRelativeDir: string
  is_uni_modules: boolean
  extApis?: Record<string, [string, string]>
  transform?: UTSOutputOptions['transform']
  uniModules: string[]
}

export async function runKotlinDev(
  filename: string,
  {
    components,
    isX,
    isSingleThread,
    isPlugin,
    cacheDir,
    pluginRelativeDir,
    is_uni_modules,
    extApis,
    transform,
    sourceMap,
    uniModules,
  }: RunKotlinDevOptions
): Promise<RunKotlinDevResult | undefined> {
  // 文件有可能是 app-ios 里边的，因为编译到 android 时，为了保证不报错，可能会去读取 ios 下的 uts
  if (filename.includes('app-ios')) {
    return
  }
  const inputDir = process.env.UNI_INPUT_DIR
  const outputDir = process.env.UNI_OUTPUT_DIR
  const result = (await compile(filename, {
    inputDir,
    outputDir,
    sourceMap,
    components,
    isX,
    isSingleThread,
    isPlugin,
    extApis,
    transform,
    uniModules,
  })) as RunKotlinDevResult
  if (!result) {
    return
  }
  if (result.error) {
    throw parseUTSSyntaxError(result.error, inputDir)
  }
  result.type = 'kotlin'
  result.changed = []

  const kotlinFile = resolveUTSPlatformFile(filename, {
    isX,
    inputDir,
    outputDir,
    platform: 'app-android',
    extname: '.kt',
    components,
    package: '',
    result,
  })
  // 开发模式下，需要生成 dex
  if (fs.existsSync(kotlinFile)) {
    const compilerServer = getCompilerServer<KotlinCompilerServer>(
      'uniapp-runextension'
    )
    if (!compilerServer) {
      throw new Error(`项目使用了uts插件，正在安装 uts Android 运行扩展...`)
    }
    const {
      getDefaultJar,
      getKotlincHome,
      compile: compileDex,
      checkDependencies,
      checkRResources,
    } = compilerServer
    let deps: string[] = []
    if (checkDependencies) {
      deps = await checkDeps(filename, checkDependencies)
    }
    let resDeps: string[] = []
    if (checkRResources) {
      resDeps = await checkRes(filename, checkRResources)
    }
    // time = Date.now()
    const jarFile = resolveJarPath(
      'app-android',
      cacheDir,
      pluginRelativeDir,
      kotlinFile
    )
    const waiting = { done: undefined }
    const kotlinFiles = [kotlinFile].concat(
      result.chunks?.map((chunk) =>
        path.resolve(path.dirname(kotlinFile), chunk)
      ) || []
    )

    const uniModuleDeps: string[] = []
    if (transform?.uniExtApiProviderServicePlugin) {
      uniModuleDeps.push(
        ...getUniModulesCacheJarsByPlugin(
          cacheDir,
          transform.uniExtApiProviderServicePlugin
        )
      )
    }

    const extraJars = resolveLibs(filename)
      .concat(deps)
      .concat(resDeps)
      .concat(uniModuleDeps)

    const depJars = uniModules.length
      ? getUniModulesEncryptCacheJars(cacheDir, uniModules) // 加密插件jar
          .concat(getUniModulesCacheJars(cacheDir, uniModules)) // 普通插件jar
          .concat(getUniModulesJars(outputDir, uniModules)) // cli版本插件jar（没有指定cache的时候）
      : []

    const options = {
      pageCount: 0,
      kotlinc: resolveKotlincArgs(
        kotlinFiles,
        jarFile,
        getKotlincHome(),
        (isX ? getDefaultJar(2) : getDefaultJar())
          .concat(extraJars)
          .concat(depJars)
      ),
      d8: resolveD8Args(jarFile),
      sourceRoot: inputDir,
      sourceMapPath: resolveSourceMapFile(outputDir, kotlinFile),
      stderrListener: createStderrListener(
        outputDir,
        resolveSourceMapPath(),
        waiting
      ),
    }
    // console.log('dex compile options: ', options)
    const { code, msg } = await compileDex(options, inputDir)
    // console.log('dex compile time: ' + (Date.now() - time) + 'ms')
    // 等待 stderrListener 执行完毕
    if (waiting.done) {
      await waiting.done
    }
    if (!code) {
      try {
        // 其他插件或 x 需要该插件的 jar 做编译
        // fs.unlinkSync(jarFile)
        // 短期内先不删除，方便排查问题
        // fs.unlinkSync(kotlinFile)
      } catch (e) {}
      const dexFile = resolveDexFile(jarFile)
      if (fs.existsSync(dexFile)) {
        const newDexFile = restoreDex(
          pluginRelativeDir,
          cacheDir,
          outputDir,
          is_uni_modules
        )
        result.changed = [
          normalizePath(path.relative(outputDir, newDexFile || dexFile)),
        ]
      }
    } else if (msg) {
      console.error(msg)
    }
    // else {
    //   throw `${normalizePath(
    //     path.relative(process.env.UNI_INPUT_DIR, filename)
    //   )} 编译失败`
    // }
  }
  return result
}

function checkDeps(
  filename: string,
  checkDependencies: (
    configJsonFile: string
  ) => Promise<{ code: number; msg: string; data: string[] }>
) {
  const configJsonFile = resolveConfigJsonFile(filename)
  if (configJsonFile && hasDeps(configJsonFile)) {
    return checkDependencies(configJsonFile).then(({ code, msg, data }) => {
      if (code !== 0) {
        console.error(msg)
        return []
      }
      return data
    })
  }
  return Promise.resolve([])
}

export function hasDeps(configJsonFile: string) {
  const deps =
    parseJson(fs.readFileSync(configJsonFile, 'utf8')).dependencies || []
  if (isArray(deps) && deps.length) {
    return true
  }
  return false
}

function checkRes(
  filename: string,
  checkRResources: (resDir: string) => Promise<{
    code: number
    msg: string
    data: { jarPath: string; uniModuleName: string }
  }>
) {
  const resDir = resolveResDir(filename)
  if (resDir) {
    return checkRResources(resDir).then(({ code, msg, data }) => {
      if (code !== 0) {
        console.error(msg)
        return []
      }
      return [data.jarPath]
    })
  }
  return Promise.resolve([])
}

function resolveResDir(filename: string) {
  const resDir = path.resolve(resolveAndroidDir(filename), 'res')
  if (fs.existsSync(resDir)) {
    return resDir
  }
}

function resolveAndroidResourceClass(filename: string) {
  const resDir = resolveResDir(filename)
  if (resDir && fs.readdirSync(resDir).length) {
    const pkg = resolveAndroidManifestPackage(filename)
    if (pkg) {
      return pkg + '.R'
    }
  }
}

const packageRe = /\s+package="(.*)"/
function resolveAndroidManifestPackage(filename: string) {
  const manifestXmlPath = path.resolve(
    resolveAndroidDir(filename),
    'AndroidManifest.xml'
  )
  if (fs.existsSync(manifestXmlPath)) {
    const matches = fs.readFileSync(manifestXmlPath, 'utf8').match(packageRe)
    if (matches && matches[1]) {
      return matches[1]
    }
  }
}

const deps = ['AndroidManifest.xml', 'config.json']

export function resolveAndroidDepFiles(filename: string) {
  const dir = resolveAndroidDir(filename)
  return deps.map((dep) => path.resolve(dir, dep))
}

function resolveConfigJsonFile(filename: string) {
  const configJsonFile = path.resolve(
    resolveAndroidDir(filename),
    'config.json'
  )
  if (fs.existsSync(configJsonFile)) {
    return configJsonFile
  }
}

const DEFAULT_IMPORTS = [
  'kotlinx.coroutines.async',
  'kotlinx.coroutines.CoroutineScope',
  'kotlinx.coroutines.Deferred',
  'kotlinx.coroutines.Dispatchers',
  'io.dcloud.uts.Map',
  'io.dcloud.uts.Set',
  'io.dcloud.uts.UTSAndroid',
  'io.dcloud.uts.*',
  'io.dcloud.uniapp.*',
]

const DEFAULT_IMPORTS_X = [
  'io.dcloud.uniapp.framework.*',
  'io.dcloud.uniapp.vue.*',
  'io.dcloud.uniapp.vue.shared.*',
  'io.dcloud.uniapp.runtime.*',
]

export async function compile(
  filename: string,
  {
    inputDir,
    outputDir,
    sourceMap,
    components,
    isX,
    isSingleThread,
    isPlugin,
    extApis,
    transform,
    uniModules,
  }: ToKotlinOptions
) {
  const { bundle, UTSTarget } = getUTSCompiler()
  // let time = Date.now()
  const imports = [...DEFAULT_IMPORTS]
  if (isX && !process.env.UNI_UTS_DISABLE_X_IMPORT) {
    imports.push(...DEFAULT_IMPORTS_X)
  }
  const rClass = resolveAndroidResourceClass(filename)
  if (rClass) {
    imports.push(rClass)
  }
  if (isUniCloudSupported() || process.env.NODE_ENV !== 'production') {
    imports.push('io.dcloud.unicloud.*')
  }
  // 本地 provider
  if (transform?.uniExtApiProviderServicePlugin) {
    imports.push(
      parseKotlinPackageWithPluginId(
        transform.uniExtApiProviderServicePlugin,
        true
      ) + '.*'
    )
  } else {
    // 本地 provider 的时候，不要引入 io.dcloud.uniapp.extapi.*，因为里边包含了相同的类型定义
    imports.push('io.dcloud.uniapp.extapi.*')
  }
  const componentsCode = genComponentsCode(filename, components, isX)
  const { package: pluginPackage, id: pluginId } = parseKotlinPackage(filename)
  const input: UTSInputOptions = {
    root: inputDir,
    filename,
    pluginId,
    paths: {
      vue: 'io.dcloud.uniapp.vue',
      '@dcloudio/uni-app': 'io.dcloud.uniapp.framework',
    },
    uniModules,
  }
  const isUTSFileExists = fs.existsSync(filename)
  if (componentsCode) {
    if (!isUTSFileExists) {
      input.fileContent = componentsCode
    } else {
      input.fileContent =
        fs.readFileSync(filename, 'utf8') + `\n` + componentsCode
    }
  } else {
    // uts文件不存在，且也无组件
    if (!isUTSFileExists) {
      return
    }
  }
  const options: UTSBundleOptions = {
    mode: process.env.NODE_ENV,
    hbxVersion: process.env.HX_Version || process.env.UNI_COMPILER_VERSION,
    input,
    output: {
      isX,
      isSingleThread,
      isPlugin,
      outDir: outputDir,
      package: pluginPackage,
      sourceMap: sourceMap ? resolveUTSSourceMapPath() : false,
      extname: 'kt',
      imports,
      logFilename: true,
      noColor: !isColorSupported(),
      split: true,
      disableSplitManifest: true,
      transform: {
        uniExtApiDefaultNamespace: 'io.dcloud.uniapp.extapi',
        uniExtApiNamespaces: extApis,
        uniExtApiDefaultParameters: parseExtApiDefaultParameters(),
        ...transform,
      },
    },
  }
  // console.log('bundle options', options)
  const result = await bundle(UTSTarget.KOTLIN, options)
  sourceMap &&
    moveRootIndexSourceMap(filename, {
      isX,
      inputDir,
      outputDir,
      platform: 'app-android',
      extname: '.kt',
      components,
      package: '',
      result,
    })
  return result
}

export function resolveKotlincArgs(
  files: string[],
  dest: string,
  kotlinc: string,
  jars: string[]
) {
  return [
    ...files,
    '-cp',
    resolveClassPath(jars),
    '-d',
    dest,
    '-kotlin-home',
    kotlinc,
    `-Xplugin=${path.resolve(
      __dirname,
      '../lib/kotlin/lib/uts-kotlin-compiler-plugin.jar'
    )}`,
    '-P',
    'plugin:io.dcloud.uts.kotlin:tag=UTS',
    '-P',
    'plugin:io.dcloud.uts.kotlin:console=true',
  ]
}

export const D8_DEFAULT_ARGS = ['--min-api', '19']

export function resolveD8Args(filename: string) {
  return [filename, ...D8_DEFAULT_ARGS, '--output', resolveDexPath(filename)]
}

function resolveLibs(filename: string) {
  const libsPath = path.resolve(resolveAndroidDir(filename), 'libs')
  const libs: string[] = []
  if (fs.existsSync(libsPath)) {
    libs.push(...sync('*.jar', { cwd: libsPath, absolute: true }))
    const zips = sync('*.aar', { cwd: libsPath })
    zips.forEach((name) => {
      const outputPath = resolveAndroidArchiveOutputPath(name)
      // 每次都解压，避免aar或jar更新后，未解压
      const zip = new AdmZip(path.resolve(libsPath, name))
      zip.extractAllTo(outputPath, true)
      libs.push(
        ...sync('**/*.jar', {
          cwd: outputPath,
          absolute: true,
        })
      )
    })
  }
  return libs
}

export function resolveAndroidArchiveOutputPath(aar: string) {
  return path.resolve(
    kotlinAARDir(process.env.UNI_OUTPUT_DIR),
    aar.replace('.aar', '')
  )
}

export function resolveDexFile(jarFile: string) {
  return normalizePath(path.resolve(path.dirname(jarFile), 'classes.dex'))
}

function resolveDexPath(filename: string) {
  return path.dirname(filename)
}

export function resolveJarPath(
  platform: APP_PLATFORM,
  cacheDir: string,
  pluginRelativeDir: string,
  filename: string
) {
  if (cacheDir) {
    return join(
      cacheDir,
      platform,
      'uts',
      pluginRelativeDir,
      path.basename(filename).replace(path.extname(filename), '.jar')
    )
  }
  return filename.replace(path.extname(filename), '.jar')
}

function resolveClassPath(jars: string[]) {
  return jars.join(os.platform() === 'win32' ? ';' : ':')
}

export function checkAndroidVersionTips(
  pluginId: string,
  pluginDir: string,
  is_uni_modules: boolean
) {
  const configJsonFile = join(
    pluginDir,
    is_uni_modules ? 'utssdk' : '',
    'app-android',
    'config.json'
  )
  if (configJsonFile && fs.existsSync(configJsonFile)) {
    try {
      const configJson = parseJson(fs.readFileSync(configJsonFile, 'utf8'))
      if (configJson.minSdkVersion && parseInt(configJson.minSdkVersion) > 19) {
        const androidVersion = get(configJson.minSdkVersion)
        if (androidVersion) {
          return `uts插件[${pluginId}]需在 Android ${androidVersion.semver} 版本及以上方可正常使用`
        }
      }
    } catch (e) {}
  }
}

export function getUniModulesEncryptCacheJars(
  cacheDir: string,
  plugins?: string[]
) {
  if (cacheDir) {
    return sync(`uni_modules/${createPluginGlob(plugins)}/*.jar`, {
      cwd: cacheDir,
      absolute: true,
    })
  }
  return []
}

function getUniModulesCacheJarsByPlugin(cacheDir: string, plugin: string) {
  if (cacheDir) {
    return sync('app-android/uts/uni_modules/' + plugin + '/index.jar', {
      cwd: cacheDir,
      absolute: true,
    })
  }
  return []
}

export function getUniModulesCacheJars(cacheDir: string, plugins?: string[]) {
  if (cacheDir) {
    return sync(
      `app-android/uts/uni_modules/${createPluginGlob(plugins)}/index.jar`,
      {
        cwd: cacheDir,
        absolute: true,
      }
    )
  }
  return []
}

export function getUniModulesJars(outputDir: string, plugins?: string[]) {
  return sync(`${createPluginGlob(plugins)}/utssdk/app-android/index.jar`, {
    cwd: path.resolve(outputDir, 'uni_modules'),
    absolute: true,
  })
}

function createPluginGlob(plugins?: string[]) {
  if (plugins && plugins.length) {
    return plugins.length > 1 ? `(${plugins.join('|')})` : plugins[0]
  }
  return '*'
}

export function createStderrListener(
  inputDir: string,
  sourceMapDir: string,
  waiting: { done: Promise<void> | undefined }
) {
  return async function stderrListener(data: any) {
    waiting.done = new Promise(async (resolve) => {
      let message = data.toString().trim()
      if (message) {
        try {
          const messages = (
            JSON.parse(message) as MessageSourceLocation[]
          ).filter((msg) => {
            if (
              // 暂时屏蔽 Unchecked cast: Any? to UTSArray<String>​
              // Unchecked cast: Any to UTSArray<String>
              msg.type === 'warning' &&
              msg.message.includes('Unchecked cast: Any') &&
              msg.message.includes('to UTSArray<')
            ) {
              return false
            }
            return true
          })
          if (messages.length) {
            const msg = await parseUTSKotlinStacktrace(messages, {
              inputDir,
              sourceMapDir,
              replaceTabsWithSpace: true,
              format: hbuilderFormatter,
            })
            if (msg) {
              // 异步输出，保证插件编译失败的日志在他之前输出，不能使用process.nextTick
              setTimeout(() => {
                console.log(msg)
              })
            }
          }
        } catch (e) {
          if (
            // 屏蔽部分不需要的警告信息
            !(
              message === ':' ||
              message.includes('Warning in') ||
              message.includes('desugaring of')
            )
          ) {
            // 异步输出，保证插件编译失败的日志在他之前输出
            setTimeout(() => {
              console.error(message)
            })
          }
        }
      }
      resolve()
    })
  }
}

export function kotlinDir(outputDir: string) {
  return (
    process.env.UNI_APP_X_CACHE_DIR || path.resolve(outputDir, '../.kotlin')
  )
}

function kotlinAARDir(kotlinDir: string) {
  return path.resolve(kotlinDir, 'aar')
}

export function parseUTSModuleLibsJars(plugins: string[]) {
  const jars = new Set<string>()
  plugins.forEach((plugin) => {
    const libsPath = path.resolve(
      process.env.UNI_INPUT_DIR,
      'uni_modules',
      plugin,
      'utssdk',
      'app-android',
      'libs'
    )
    if (fs.existsSync(libsPath)) {
      sync('*.jar', { cwd: libsPath, absolute: true }).forEach((jar) => {
        jars.add(jar)
      })
      const aars = sync('*.aar', { cwd: libsPath })
      aars.forEach((name) => {
        const outputPath = resolveAndroidArchiveOutputPath(name)
        if (fs.existsSync(outputPath)) {
          sync('**/*.jar', {
            cwd: outputPath,
            absolute: true,
          }).forEach((jar) => {
            jars.add(jar)
          })
        }
      })
    }
  })
  return [...jars]
}

function checkDepsByPlugin(
  checkType: 1 | 2,
  plugin: string,
  checkDependencies: Required<KotlinCompilerServer>['checkDependencies'],
  checkDependenciesValid: boolean,
  checkError: (plugin: string) => void
) {
  const configJsonFile = path.resolve(
    process.env.UNI_INPUT_DIR,
    'uni_modules',
    plugin,
    'utssdk',
    'app-android',
    'config.json'
  )

  if (fs.existsSync(configJsonFile) && hasDeps(configJsonFile)) {
    return checkDependencies(configJsonFile, {
      type: checkType,
      valid: checkDependenciesValid,
    }).then(({ code, msg, data }) => {
      if (code !== 0) {
        console.error(msg)
        checkError(plugin)
        return []
      }
      return data
    })
  }
  return Promise.resolve([])
}

export async function parseUTSModuleConfigJsonJars(
  checkType: 1 | 2,
  plugins: string[],
  checkDependencies: Required<KotlinCompilerServer>['checkDependencies'],
  checkDependenciesValid: boolean,
  checkError: (plugin: string) => void
) {
  const deps = new Set<string>()

  for (const plugin of plugins) {
    ;(
      await checkDepsByPlugin(
        checkType,
        plugin,
        checkDependencies,
        checkDependenciesValid,
        checkError
      )
    ).forEach((dep) => deps.add(dep))
  }
  return [...deps]
}
