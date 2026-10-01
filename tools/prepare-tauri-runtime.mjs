import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' })
}

function readRpaths(loadCommands) {
  const lines = loadCommands.split(/\r?\n/)
  const rpaths = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'cmd LC_RPATH') continue
    for (let next = index + 1; next < lines.length; next += 1) {
      const match = lines[next].trim().match(/^path (.+) \(offset \d+\)$/)
      if (match) {
        rpaths.push(match[1])
        break
      }
      if (lines[next].trim().startsWith('cmd ')) break
    }
  }
  return rpaths
}

function resolveNodeLibrary(reference, rpaths, execPath) {
  const executableDirs = new Set([dirname(execPath)])
  try {
    executableDirs.add(dirname(resolve(execPath)))
  } catch {}

  const candidates = []
  if (isAbsolute(reference)) candidates.push(reference)
  else if (reference.startsWith('@rpath/')) {
    const suffix = reference.slice('@rpath/'.length)
    for (const executableDir of executableDirs) {
      for (const rpath of rpaths) {
        const expanded = rpath
          .replace(/^@executable_path/, executableDir)
          .replace(/^@loader_path/, executableDir)
        candidates.push(join(expanded, suffix))
      }
      candidates.push(resolve(executableDir, '..', 'lib', suffix))
      candidates.push(join(executableDir, suffix))
    }
  } else if (reference.startsWith('@executable_path/')) {
    for (const executableDir of executableDirs) candidates.push(join(executableDir, reference.slice('@executable_path/'.length)))
  } else if (reference.startsWith('@loader_path/')) {
    for (const executableDir of executableDirs) candidates.push(join(executableDir, reference.slice('@loader_path/'.length)))
  }

  return candidates.find((candidate) => existsSync(candidate))
}

function cleanGeneratedRuntimeArtifacts(outputDir) {
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    const isGeneratedNodeArtifact = entry.name === 'node.exe'
      || /^libnode(?:\.\d+)?\.dylib$/.test(entry.name)
      || entry.name.toLowerCase().endsWith('.dll')
    if (!isGeneratedNodeArtifact) continue

    const artifact = join(outputDir, entry.name)
    const details = lstatSync(artifact)
    if (!details.isFile() && !details.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-file generated Node runtime artifact: ${artifact}`)
    }
    // Windows may refuse to unlink read-only files. Clear the read-only bit
    // immediately before removing a regular file; symlinks are only unlinked.
    if (details.isFile()) chmodSync(artifact, 0o666)
    unlinkSync(artifact)
  }
}

function isSystemMacOSLibrary(reference) {
  return reference.startsWith('/System/Library/')
    || reference.startsWith('/System/Volumes/Preboot/Cryptexes/OS/usr/lib/')
    || reference.startsWith('/usr/lib/')
}

function isMacOSNodeLibrary(reference) {
  return /(?:^|\/)libnode(?:\.\d+)?\.dylib$/.test(reference)
}

function copyMacOSNodeLibrary(execPath, outputDir, runCommand) {
  const dependencies = runCommand('otool', ['-L', execPath])
  const references = dependencies
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\S+)\s+\(/)?.[1])
    .filter(Boolean)
  const libraryReferences = references.filter(isMacOSNodeLibrary)
  const unsupportedReferences = references.filter((reference) => !isSystemMacOSLibrary(reference) && !isMacOSNodeLibrary(reference))
  if (unsupportedReferences.length > 0) {
    throw new Error(`Unsupported non-system macOS Node dependency ${unsupportedReferences.join(', ')} in ${execPath}; refusing to package an incomplete runtime`)
  }
  if (libraryReferences.length === 0) {
    // Official macOS Node distributions can be self-contained executables with
    // only OS-provided dylibs. Keep those binaries unchanged; do not require a
    // libnode.dylib that the distribution does not ship.
    return []
  }

  const rpaths = readRpaths(runCommand('otool', ['-l', execPath]))
  const copiedLibraries = []
  for (const reference of libraryReferences) {
    const source = resolveNodeLibrary(reference, rpaths, execPath)
    if (!source) {
      throw new Error(`Could not resolve ${reference} from Node runtime ${execPath}; install the matching Node libnode dylib before packaging`)
    }
    const destination = join(outputDir, reference.split('/').at(-1))
    copyFileSync(source, destination)
    // Homebrew ships libnode.*.dylib read-only; copyFileSync preserves the
    // mode, and a read-only staged copy breaks the next build when
    // tauri_build::copy_resources tries to overwrite it (EACCES).
    chmodSync(destination, 0o644)
    copiedLibraries.push(destination)
  }

  // Relocating node.exe into the app changes its executable directory. This
  // rpath makes @rpath/libnode.*.dylib resolve beside the copied executable.
  const stagedNode = join(outputDir, 'node.exe')
  if (!rpaths.includes('@executable_path')) {
    runCommand('install_name_tool', ['-add_rpath', '@executable_path', stagedNode])
  }
  // install_name_tool invalidates the copied executable's signature. Always
  // sign the staged binary after its final load-command state is established;
  // this also makes staging deterministic when the source already has the rpath.
  runCommand('codesign', ['--force', '--sign', '-', stagedNode])
  return copiedLibraries
}

function copyWindowsRuntimeDlls(execPath, outputDir) {
  const executableDir = dirname(execPath)
  const dlls = readdirSync(executableDir)
    .filter((name) => name.toLowerCase().endsWith('.dll'))
    .sort((left, right) => left.localeCompare(right))
  for (const dll of dlls) copyFileSync(join(executableDir, dll), join(outputDir, dll))
  return dlls
}

// 包体积优化（原见 .github/workflows/release.yml，b363c69；因当前 GitHub 凭证
// 无 Workflows 权限，改由构建脚本执行，workflow 版保留在历史中不动）。
//
// staged 的 src-tauri/runtime/node.exe 是 Windows PE 二进制；用 PE-capable 的
// strip（LLVM / Git-for-Windows / MSYS2 自带，或 PATH 中的 llvm-strip/strip）
// 给它瘦身。只 strip node.exe 本体，绝不碰 macOS 的 Mach-O 二进制。
// nodejs.org 自带的 Authenticode 签名会被 strip 掉（已接受）；CI 本来就不做
// Authenticode 签名。strip 发生在 tauri build 打包之前，因此 updater .sig
// 计算在 stripped bytes 之上。找不到可用工具时报错退出（fail-closed）。
const WINDOWS_STRIP_TOOL_CANDIDATES = [
  'C:\\Program Files\\LLVM\\bin\\llvm-strip.exe',
  'C:\\Program Files\\Git\\usr\\bin\\strip.exe',
  'C:\\msys64\\usr\\bin\\strip.exe',
]
const WINDOWS_STRIP_PATH_FALLBACKS = ['llvm-strip', 'strip']

function findWindowsStripTool(runCommand) {
  for (const candidate of WINDOWS_STRIP_TOOL_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  for (const name of WINDOWS_STRIP_PATH_FALLBACKS) {
    try {
      runCommand(name, ['--version'])
      return name
    } catch {
      // 该工具不在 PATH 中，继续试下一个
    }
  }
  return null
}

export function stripWindowsNodeBinary({ nodeExe, runCommand = run } = {}) {
  if (!nodeExe || !existsSync(nodeExe) || !statSync(nodeExe).isFile()) {
    throw new Error(`Expected staged Windows Node sidecar at ${nodeExe}`)
  }
  const stripBin = findWindowsStripTool(runCommand)
  if (!stripBin) {
    throw new Error(
      'No PE-capable strip tool found (checked LLVM / Git-for-Windows / MSYS2 install paths and PATH llvm-strip/strip); refusing to package an unstripped Windows Node sidecar'
    )
  }
  const before = statSync(nodeExe).size
  runCommand(stripBin, [nodeExe])
  const after = statSync(nodeExe).size
  console.log(`Stripped ${nodeExe} with ${stripBin}: ${before} -> ${after} bytes`)
  return { stripBin, before, after }
}

export function prepareRuntime({
  platform = process.platform,
  execPath = process.execPath,
  outputDir = join(root, 'src-tauri', 'runtime'),
  runCommand = run,
} = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Tauri sidecar packaging requires Node.js >=22.13 (found ${process.versions.node})`)
  }

  mkdirSync(outputDir, { recursive: true })
  cleanGeneratedRuntimeArtifacts(outputDir)
  const output = join(outputDir, 'node.exe')
  copyFileSync(execPath, output)
  if (platform !== 'win32') chmodSync(output, 0o755)

  let extras = []
  if (platform === 'darwin') {
    extras = copyMacOSNodeLibrary(execPath, outputDir, runCommand)
  } else if (platform === 'win32') {
    extras = copyWindowsRuntimeDlls(execPath, outputDir)
  }

  return { output, extras }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { output, extras } = prepareRuntime()
  if (process.platform === 'win32') {
    // 与原 workflow 语义一致：staging 落盘之后、tauri build 打包之前 strip。
    // 放在 CLI 入口而非 prepareRuntime() 内：保持导出的 prepareRuntime 纯粹、
    // 可被测试直接调用；npm run tauri:prepare 走的正是这条路径。
    stripWindowsNodeBinary({ nodeExe: output })
  }
  console.log(`Prepared Node ${process.versions.node} (${process.platform}/${process.arch}) at ${output}; bundled ${extras.length} platform runtime library file(s)`)
}
