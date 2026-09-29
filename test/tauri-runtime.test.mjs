import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareRuntime } from '../tools/prepare-tauri-runtime.mjs'

const tempRoot = mkdtempSync(join(tmpdir(), 'meridian-tauri-runtime-'))
try {
  const macBin = join(tempRoot, 'mac', 'bin')
  const macLib = join(tempRoot, 'mac', 'lib')
  const macOutput = join(tempRoot, 'mac-output')
  mkdirSync(macBin, { recursive: true })
  mkdirSync(macLib, { recursive: true })
  const macNode = join(macBin, 'node')
  const macLibrary = join(macLib, 'libnode.147.dylib')
  writeFileSync(macNode, 'mac-node executable')
  writeFileSync(macLibrary, 'libnode shared library')
  const installNameToolCalls = []
  const macRun = (command, args) => {
    assert.equal(command, args[0] === '-add_rpath' ? 'install_name_tool' : 'otool')
    if (command === 'install_name_tool') {
      installNameToolCalls.push(args)
      return ''
    }
    if (args[0] === '-L') return `${macNode}:\n\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version 147.0.0)\n`
    if (args[0] === '-l') return `Load command 1\n      cmd LC_RPATH\n  cmdsize 40\n     path @executable_path/../lib (offset 12)\n`
    throw new Error(`Unexpected otool arguments: ${args.join(' ')}`)
  }
  const macResult = prepareRuntime({ platform: 'darwin', execPath: macNode, outputDir: macOutput, runCommand: macRun })
  assert.equal(readFileSync(join(macOutput, 'node.exe'), 'utf8'), 'mac-node executable')
  assert.equal(readFileSync(join(macOutput, 'libnode.147.dylib'), 'utf8'), 'libnode shared library')
  assert.deepEqual(macResult.extras, [join(macOutput, 'libnode.147.dylib')])
  assert.deepEqual(installNameToolCalls, [['-add_rpath', '@executable_path', join(macOutput, 'node.exe')]])

  const preservedMacFile = join(macOutput, 'notes.txt')
  writeFileSync(preservedMacFile, 'keep unrelated runtime data')
  const stagedMacLibrary = join(macOutput, 'libnode.147.dylib')
  chmodSync(stagedMacLibrary, 0o444)
  writeFileSync(macLibrary, 'updated libnode shared library')
  prepareRuntime({ platform: 'darwin', execPath: macNode, outputDir: macOutput, runCommand: macRun })
  assert.equal(readFileSync(stagedMacLibrary, 'utf8'), 'updated libnode shared library')
  assert.notEqual(statSync(stagedMacLibrary).mode & 0o222, 0, 'replaced macOS dylib should not retain its read-only mode')
  assert.equal(readFileSync(preservedMacFile, 'utf8'), 'keep unrelated runtime data')

  const winBin = join(tempRoot, 'windows', 'bin')
  const winOutput = join(tempRoot, 'windows-output')
  mkdirSync(winBin, { recursive: true })
  const winNode = join(winBin, 'node.exe')
  writeFileSync(winNode, 'windows-node executable')
  writeFileSync(join(winBin, 'vcruntime140.dll'), 'runtime dependency')
  writeFileSync(join(winBin, 'readme.txt'), 'not a DLL')
  const winResult = prepareRuntime({ platform: 'win32', execPath: winNode, outputDir: winOutput })
  assert.equal(readFileSync(join(winOutput, 'node.exe'), 'utf8'), 'windows-node executable')
  assert.equal(readFileSync(join(winOutput, 'vcruntime140.dll'), 'utf8'), 'runtime dependency')
  assert.deepEqual(winResult.extras, ['vcruntime140.dll'])
  const preservedWindowsFile = join(winOutput, 'notes.txt')
  writeFileSync(preservedWindowsFile, 'keep unrelated runtime data')
  const stagedWindowsDll = join(winOutput, 'vcruntime140.dll')
  chmodSync(stagedWindowsDll, 0o444)
  writeFileSync(join(winBin, 'vcruntime140.dll'), 'updated runtime dependency')
  writeFileSync(join(winOutput, 'stale-node-runtime.dll'), 'stale generated DLL')
  chmodSync(join(winOutput, 'stale-node-runtime.dll'), 0o444)
  prepareRuntime({ platform: 'win32', execPath: winNode, outputDir: winOutput })
  assert.equal(readFileSync(stagedWindowsDll, 'utf8'), 'updated runtime dependency')
  assert.notEqual(statSync(stagedWindowsDll).mode & 0o222, 0, 'replaced Windows DLL should not retain its read-only mode')
  assert.equal(existsSync(join(winOutput, 'stale-node-runtime.dll')), false, 'stale generated Windows DLL should be removed')
  assert.equal(readFileSync(preservedWindowsFile, 'utf8'), 'keep unrelated runtime data')

  const brokenBin = join(tempRoot, 'broken', 'bin')
  mkdirSync(brokenBin, { recursive: true })
  const brokenNode = join(brokenBin, 'node')
  writeFileSync(brokenNode, 'broken mac-node executable')
  const brokenOutput = join(tempRoot, 'broken-output')
  assert.throws(() => prepareRuntime({
    platform: 'darwin',
    execPath: brokenNode,
    outputDir: brokenOutput,
    runCommand: (_command, args) => args[0] === '-L'
      ? `${brokenNode}:\n\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version 147.0.0)\n`
      : 'Load command 1\n      cmd LC_RPATH\n  cmdsize 40\n     path @executable_path/not-present (offset 12)\n',
  }), /Could not resolve @rpath\/libnode\.147\.dylib/)

  console.log('Tauri runtime packaging: idempotent read-only replacement, preserved unrelated files, macOS libnode/rpath, missing-library failure, and Windows DLL copying passed')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
