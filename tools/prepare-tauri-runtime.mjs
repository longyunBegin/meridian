import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
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

function copyMacOSNodeLibrary(execPath, outputDir, runCommand) {
  const dependencies = runCommand('otool', ['-L', execPath])
  const libraryReferences = dependencies
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\S*libnode(?:\.\d+)?\.dylib)\s+\(/)?.[1])
    .filter(Boolean)
  if (libraryReferences.length === 0) {
    throw new Error(`Could not find a libnode dependency in ${execPath}; refusing to package an incomplete macOS Node runtime`)
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
    copiedLibraries.push(destination)
  }

  // Relocating node.exe into the app changes its executable directory. This
  // rpath makes @rpath/libnode.*.dylib resolve beside the copied executable.
  if (!rpaths.includes('@executable_path')) {
    runCommand('install_name_tool', ['-add_rpath', '@executable_path', join(outputDir, 'node.exe')])
  }
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
  console.log(`Prepared Node ${process.versions.node} (${process.platform}/${process.arch}) at ${output}; bundled ${extras.length} platform runtime library file(s)`)
}
