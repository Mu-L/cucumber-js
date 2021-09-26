import { ISupportCodeLibrary } from '../support_code_library_builder/types'
import { IParsedArgvFormatOptions } from '../cli/argv_parser'

export interface IRunConfiguration {
  sources: {
    defaultDialect?: string
    paths: string[]
  }
  pickles?: {
    order?: string
    names?: string[]
    tagExpression?: string
  }
  support?:
    | {
        transpileWith?: string[]
        paths: string[]
      }
    | ISupportCodeLibrary
  runtime?: {
    dryRun?: boolean
    failFast?: boolean
    filterStacktraces?: boolean
    parallel?: {
      count: number
    }
    retry?: {
      count: number
      tagExpression?: string
    }
    strict?: boolean
    worldParameters?: any
  }
  formats?: {
    stdout: string
    files?: Record<string, string>
    options?: IParsedArgvFormatOptions
  }
}
