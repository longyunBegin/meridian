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
  const macCommandCalls = []
  const macRun = (command, args) => {
    macCommandCalls.push([command, args])
    if (command === 'install_name_tool') {
      return ''
    }
    if (command === 'codesign') return ''
    assert.equal(command, 'otool')
    if (args[0] === '-L') return `${macNode}:\n\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version 147.0.0)\n`
    if (args[0] === '-l') return `Load command 1\n      cmd LC_RPATH\n  cmdsize 40\n     path @executable_path/../lib (offset 12)\n`
    throw new Error(`Unexpected otool arguments: ${args.join(' ')}`)
  }
  const macResult = prepareRuntime({ platform: 'darwin', execPath: macNode, outputDir: macOutput, runCommand: macRun })
  assert.equal(readFileSync(join(macOutput, 'node.exe'), 'utf8'), 'mac-node executable')
  assert.equal(readFileSync(join(macOutput, 'libnode.147.dylib'), 'utf8'), 'libnode shared library')
  assert.deepEqual(macResult.extras, [join(macOutput, 'libnode.147.dylib')])
  const stagedMacNode = join(macOutput, 'node.exe')
  assert.deepEqual(macCommandCalls, [
    ['otool', ['-L', macNode]],
    ['otool', ['-l', macNode]],
    ['install_name_tool', ['-add_rpath', '@executable_path', stagedMacNode]],
    ['codesign', ['--force', '--sign', '-', stagedMacNode]],
  ], 'the staged executable must be ad-hoc signed after its rpath is modified')

  const preservedMacFile = join(macOutput, 'notes.txt')
  writeFileSync(preservedMacFile, 'keep unrelated runtime data')
  const stagedMacLibrary = join(macOutput, 'libnode.147.dylib')
  chmodSync(stagedMacLibrary, 0o444)
  writeFileSync(macLibrary, 'updated libnode shared library')
  prepareRuntime({ platform: 'darwin', execPath: macNode, outputDir: macOutput, runCommand: macRun })
  assert.equal(readFileSync(stagedMacLibrary, 'utf8'), 'updated libnode shared library')
  assert.notEqual(statSync(stagedMacLibrary).mode & 0o222, 0, 'replaced macOS dylib should not retain its read-only mode')
  assert.equal(readFileSync(preservedMacFile, 'utf8'), 'keep unrelated runtime data')
  assert.deepEqual(macCommandCalls.slice(-4), [
    ['otool', ['-L', macNode]],
    ['otool', ['-l', macNode]],
    ['install_name_tool', ['-add_rpath', '@executable_path', stagedMacNode]],
    ['codesign', ['--force', '--sign', '-', stagedMacNode]],
  ], 'repeated preparation must apply the same rpath-then-sign sequence')

  const existingRpathCalls = []
  prepareRuntime({
    platform: 'darwin',
    execPath: macNode,
    outputDir: join(tempRoot, 'mac-existing-rpath-output'),
    runCommand: (command, args) => {
      existingRpathCalls.push([command, args])
      if (command === 'codesign') return ''
      assert.equal(command, 'otool')
      if (args[0] === '-L') return `${macNode}:\n\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version 147.0.0)\n`
      return 'Load command 1\n      cmd LC_RPATH\n  cmdsize 40\n     path @executable_path (offset 12)\n'
    },
  })
  assert.deepEqual(existingRpathCalls, [
    ['otool', ['-L', macNode]],
    ['otool', ['-l', macNode]],
    ['codesign', ['--force', '--sign', '-', join(tempRoot, 'mac-existing-rpath-output', 'node.exe')]],
  ], 'an existing rpath should not be duplicated, and the staged executable should still be signed')

  const signingFailureCalls = []
  assert.throws(() => prepareRuntime({
    platform: 'darwin',
    execPath: macNode,
    outputDir: join(tempRoot, 'mac-signing-failure-output'),
    runCommand: (command, args) => {
      signingFailureCalls.push([command, args])
      if (command === 'codesign') throw new Error('codesign failed')
      if (command === 'install_name_tool') return ''
      if (args[0] === '-L') return `${macNode}:\n\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version 147.0.0)\n`
      return 'Load command 1\n      cmd LC_RPATH\n  cmdsize 40\n     path @executable_path/../lib (offset 12)\n'
    },
  }), /codesign failed/)
  assert.equal(signingFailureCalls.at(-1)[0], 'codesign', 'a signing failure must propagate and fail preparation')

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

  console.log('Tauri runtime packaging: idempotent staging, macOS libnode/rpath then ad-hoc signing (including failure), missing-library failure, and Windows DLL copying passed')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
