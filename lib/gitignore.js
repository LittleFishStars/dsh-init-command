/** .gitignore 模板匹配与下载（node:https + 系统 CA 回退）。 */

import { readFile } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'

/**
 * .gitignore 模板匹配表：[模板名, 关键词数组]，按顺序检查（靠前的先命中）。
 * 模板名必须是 github/gitignore 仓库顶层的真实文件名；关键词不含空格为
 * 分词精确匹配，含空格为整体短语匹配（大小写不敏感）。
 */
const GITIGNORE_TEMPLATES = [
  ['Nextjs', ['next.js', 'nextjs', 'next']],
  ['Nestjs', ['nestjs', 'nest.js', 'nest']],
  ['Deno', ['deno']],
  ['bun', ['bun']],
  ['Angular', ['angular']],
  ['Node', ['node.js', 'nodejs', 'node', 'javascript', 'typescript', 'npm', 'yarn', 'pnpm', 'webpack', 'vite', 'react', 'vue', 'svelte', 'express', 'nuxt', 'electron']],
  ['Flutter', ['flutter']],
  ['Dart', ['dart']],
  ['Swift', ['swift', 'ios']],
  ['Objective-C', ['objective-c', 'objc', 'objective c']],
  ['Kotlin', ['kotlin']],
  ['Android', ['android']],
  ['Java', ['java', 'spring', 'spring boot', 'spring framework', 'jvm', 'hibernate']],
  ['Gradle', ['gradle']],
  ['Maven', ['maven']],
  ['Scala', ['scala']],
  ['Clojure', ['clojure']],
  ['Dotnet', ['c#', 'csharp', '.net', 'dotnet', 'asp.net', 'aspnet']],
  ['VisualStudio', ['visual studio', 'vs.net', 'msbuild']],
  ['C++', ['c++', 'cpp']],
  ['C', ['c', 'c language']],
  ['Go', ['go', 'golang']],
  ['Rust', ['rust', 'cargo']],
  ['Python', ['python', 'django', 'flask', 'fastapi', 'jupyter', 'pandas', 'numpy', 'scikit-learn']],
  ['Ruby', ['ruby']],
  ['Rails', ['rails', 'ruby on rails']],
  ['PHP', ['php']],
  ['Laravel', ['laravel']],
  ['WordPress', ['wordpress']],
  ['Symfony', ['symfony']],
  ['Yii', ['yii']],
  ['CodeIgniter', ['codeigniter']],
  ['CakePHP', ['cakephp']],
  ['Drupal', ['drupal']],
  ['Magento', ['magento']],
  ['Joomla', ['joomla']],
  ['Composer', ['composer']],
  ['Elixir', ['elixir', 'phoenix']],
  ['Erlang', ['erlang']],
  ['Haskell', ['haskell']],
  ['OCaml', ['ocaml']],
  ['Lua', ['lua']],
  ['Luau', ['luau']],
  ['Raku', ['raku', 'perl6']],
  ['Perl', ['perl']],
  ['R', ['r']],
  ['Julia', ['julia']],
  ['Zig', ['zig']],
  ['Nim', ['nim']],
  ['D', ['d']],
  ['Delphi', ['delphi', 'pascal']],
  ['Fortran', ['fortran']],
  ['Ada', ['ada']],
  ['CommonLisp', ['common lisp', 'lisp']],
  ['Scheme', ['scheme']],
  ['Smalltalk', ['smalltalk']],
  ['Coq', ['coq']],
  ['Agda', ['agda']],
  ['Idris', ['idris']],
  ['Lean', ['lean']],
  ['Racket', ['racket']],
  ['Elisp', ['elisp', 'emacs']],
  ['TeX', ['tex', 'latex']],
  ['GitBook', ['gitbook']],
  ['Jekyll', ['jekyll']],
  ['GitHubPages', ['github pages', 'gh-pages']],
  ['Firebase', ['firebase']],
  ['Terraform', ['terraform', 'hcl']],
  ['Packer', ['packer']],
  ['ChefCookbook', ['chef', 'chef cookbook']],
  ['JENKINS_HOME', ['jenkins']],
  ['Unity', ['unity', 'unity3d']],
  ['UnrealEngine', ['unreal engine', 'unreal', 'ue4', 'ue5']],
  ['Godot', ['godot']],
  ['Qt', ['qt']],
  ['ROS', ['ros']],
  ['Processing', ['processing']],
  ['LabVIEW', ['labview']],
  ['KiCad', ['kicad']],
  ['CMake', ['cmake']],
  ['SCons', ['scons']],
  ['CUDA', ['cuda']],
  ['Gleam', ['gleam']],
  ['Haxe', ['haxe']],
  ['Nix', ['nix']],
  ['Ballerina', ['ballerina']],
  ['Actionscript', ['actionscript', 'action script']],
  ['VBA', ['vba']],
  ['Xojo', ['xojo']],
  ['Sass', ['sass', 'scss']],
  ['Salesforce', ['salesforce', 'apex']],
  ['Solidity-Remix', ['solidity']],
  ['Grails', ['grails']],
  ['PlayFramework', ['play framework']],
  ['ZendFramework', ['zend framework', 'zend']],
  ['Phalcon', ['phalcon']],
  ['Prestashop', ['prestashop']],
  ['TurboGears2', ['turbogears']],
  ['FuelPHP', ['fuelphp']],
  ['ExpressionEngine', ['expression engine']],
  ['CraftCMS', ['craft cms', 'craftcms']],
  ['Concrete5', ['concrete5']],
  ['OpenCart', ['opencart']],
  ['Textpattern', ['textpattern']],
  ['Typo3', ['typo3']],
  ['EPiServer', ['episerver']],
  ['FlaxEngine', ['flax engine']],
  ['SolidWorks', ['solidworks']],
  ['Eagle', ['eagle']],
  ['ModelSim', ['modelsim']],
  ['Modelica', ['modelica']],
  ['Lilypond', ['lilypond']],
  ['IGORPro', ['igor']],
  ['TwinCAT3', ['twincat']],
  ['VVVV', ['vvvv']],
  ['Waf', ['waf']],
  ['Yeoman', ['yeoman']],
  ['Zephir', ['zephir']],
  ['Katalon', ['katalon']],
  ['TestComplete', ['testcomplete']],
  ['LangChain', ['langchain']],
  ['MoonBit', ['moonbit']],
  ['Nanoc', ['nanoc']],
  ['Leiningen', ['leiningen']],
  ['GWT', ['gwt', 'google web toolkit']],
  ['ExtJs', ['extjs']],
  ['Gcov', ['gcov']],
  ['HIP', ['hip']],
  ['IAR', ['iar']],
  ['Opa', ['opa']],
  ['PureScript', ['purescript']],
  ['Qooxdoo', ['qooxdoo']],
  ['Sdcc', ['sdcc']],
  ['Stella', ['stella']],
  ['SugarCRM', ['sugarcrm']],
  ['AppEngine', ['app engine', 'google app engine', 'appengine']],
  ['ArchLinuxPackages', ['arch linux', 'archlinux']],
  ['Autotools', ['autotools', 'automake', 'autoconf']],
  ['CFWheels', ['cfwheels']],
  ['DM', ['dm']],
  ['JBoss', ['jboss', 'wildfly']],
  ['OracleForms', ['oracle forms']],
  ['Plone', ['plone']],
  ['SketchUp', ['sketchup']],
]

/** 按语言/工具链/项目类型匹配 github/gitignore 模板名；无匹配返回 undefined。 */
export function gitignoreTemplate(profile) {
  const candidates = [profile.languages, profile.toolchain, profile.projectType]
    .filter(Boolean)
    .map(value => value.toLowerCase())
  const tokens = new Set(candidates.flatMap(text => text.split(/[^a-z0-9.#+-]+/u).filter(Boolean)))
  const phrases = candidates.join(' ')
  for (const [template, aliases] of GITIGNORE_TEMPLATES) {
    for (const alias of aliases) {
      if (alias.includes(' ')) {
        if (phrases.includes(alias)) return template
      } else if (tokens.has(alias)) {
        return template
      }
    }
  }
  return undefined
}

/** 响应体大小上限（.gitignore 模板远小于此）。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** 用 node:https 发起 GET 请求，返回状态码与响应文本（零依赖）。 */
function httpGetText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, options, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('response body exceeded 2 MiB limit'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.setTimeout(15000, () => request.destroy(new Error('request timed out')))
    request.on('error', reject)
  })
}

/** 常见系统 CA 证书包路径（与 curl 等系统工具使用的信任库一致）。 */
const SYSTEM_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/tls/cacert.pem',
  '/etc/ssl/cert.pem',
]

/** 读取第一个可用的系统 CA 证书包；不可用时返回 undefined。 */
async function loadSystemCa() {
  for (const file of SYSTEM_CA_BUNDLES) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      // 尝试下一个候选路径。
    }
  }
  return undefined
}

/** TLS 证书校验失败的错误码（首次请求失败时触发系统 CA 回退）。 */
const TLS_VERIFY_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * 默认下载器：先用 Node 内置 CA 库请求；若证书校验失败（如本机使用系统
 * 信任库的代理/MITM 环境，Node 内置 CA 不含其根证书）则读取系统 CA 包
 * 重试一次——仍然校验证书，只是信任库与 curl 等系统工具一致。
 */
async function fetchGitignore(url) {
  try {
    return await httpGetText(url)
  } catch (error) {
    if (!TLS_VERIFY_CODES.has(error?.code)) throw error
    const ca = await loadSystemCa()
    if (ca === undefined) throw error
    return await httpGetText(url, { ca })
  }
}

/**
 * 从 github/gitignore（main 分支）下载指定模板；`fetcher` 可注入（测试用），
 * 默认走 node:https 并在证书校验失败时回退系统 CA（见 {@link fetchGitignore}）。
 */
export async function downloadGitignore(template, fetcher = fetchGitignore) {
  const url = `https://raw.githubusercontent.com/github/gitignore/main/${encodeURIComponent(template)}.gitignore`
  const response = await fetcher(url)
  return { ok: response.status === 200, status: response.status, text: response.text }
}
