import { describe, expect, it } from 'vitest'
import { Config, apply, name } from '../src/index.ts'

describe('plugin template', () => {
  it('exposes its plugin id', () => {
    expect(name).toBe('dsh-plugin-template')
  })

  it('fills config defaults', () => {
    // The schema is the single source of defaults: an empty row config resolves
    // to the declared default instead of failing validation.
    const result = Config['~standard'].validate({})
    expect(result).toEqual({ value: { greeting: 'hello from dsh-plugin-template' } })
  })

  it('exposes an apply function', () => {
    expect(apply).toBeTypeOf('function')
  })
})
