import { describe, expect, it } from 'vitest'
import { commandFailureNotice, detectMaskedCommandFailure } from './commandSafety'

describe('detectMaskedCommandFailure', () => {
  it('flags permission-denied file operations even when shell output later claims success', () => {
    const signal = detectMaskedCommandFailure([
      'mv: rename ScreenShot.png to /Users/test/.Trash/ScreenShot.png: Operation not permitted',
      'mv: rename Weixin.png to /Users/test/.Trash/Weixin.png: Operation not permitted',
      '已清空'
    ].join('\n'))

    expect(signal).toEqual({
      title: 'Permission blocked',
      detail: [
        'mv: rename ScreenShot.png to /Users/test/.Trash/ScreenShot.png: Operation not permitted',
        'mv: rename Weixin.png to /Users/test/.Trash/Weixin.png: Operation not permitted'
      ].join('\n')
    })
  })

  it('does not flag generic logs without a file operation marker', () => {
    expect(detectMaskedCommandFailure('log fixture: Operation not permitted')).toBeNull()
  })
})

describe('commandFailureNotice', () => {
  it('uses a neutral verified failure message', () => {
    expect(commandFailureNotice({
      title: 'Permission blocked',
      detail: 'mv: Operation not permitted'
    })).toBe('Permission blocked.\n\nThe requested action did not complete. The command output shows a filesystem permission block, so success was not confirmed.')
  })
})
