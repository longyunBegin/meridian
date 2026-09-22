/**
 * API 密钥加密。AES-256-GCM，机器绑定——换机器后密钥失效。
 *
 * 零依赖，用 Node.js 内置 crypto。密钥从机器信息派生（hostname + username + app name），
 * 不存密钥文件，不联网。向后兼容：非 enc: 前缀的值当作明文直接返回。
 */
import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'node:crypto'
import { hostname, userInfo } from 'node:os'

const SALT = 'meridian-key-vault'
const PREFIX = 'enc:v1:'

function deriveKey() {
  const user = (() => { try { return userInfo().username || 'anon' } catch { return 'anon' } })()
  const pass = `${hostname()}|${user}|meridian`
  return scryptSync(pass, SALT, 32)
}

/**
 * 加密明文。返回 `enc:v1:base64(iv|authTag|ciphertext)`。
 * 空字符串原样返回（不加密空值）。
 */
export function encrypt(plain) {
  if (!plain || typeof plain !== 'string' || !plain.trim()) return plain
  if (plain.startsWith(PREFIX)) return plain
  try {
    const key = deriveKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
  } catch {
    return plain
  }
}

/**
 * 解密。非 `enc:v1:` 前缀的值原样返回（向后兼容明文）。
 */
export function decrypt(value) {
  if (!value || typeof value !== 'string' || !value.startsWith(PREFIX)) return value
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const enc = raw.subarray(28)
    const key = deriveKey()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

/** 加密 settings 中的密钥字段 */
export function encryptSettings(s) {
  return {
    ...s,
    apiKey: encrypt(s.apiKey),
    jevKey: encrypt(s.jevKey),
  }
}

/** 解密 settings 中的密钥字段 */
export function decryptSettings(s) {
  return {
    ...s,
    apiKey: decrypt(s.apiKey),
    jevKey: decrypt(s.jevKey),
  }
}