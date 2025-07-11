import { EventEmitter } from 'node:events'
import sinon from 'sinon'
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import * as messages from '@cucumber/messages'
import { Envelope, IdGenerator } from '@cucumber/messages'
import FakeTimers, { InstalledClock } from '@sinonjs/fake-timers'
import { buildSupportCodeLibrary } from '../../test/runtime_helpers'
import { parse } from '../../test/gherkin_helpers'
import timeMethods from '../time'
import { getBaseSupportCodeLibrary } from '../../test/fixtures/steps'
import { SupportCodeLibrary } from '../support_code_library_builder/types'
import { valueOrDefault } from '../value_checker'
import { assembleTestCases } from '../assemble'
import TestCaseRunner from './test_case_runner'

async function testRunner(options: {
  workerId?: string
  gherkinDocument: messages.GherkinDocument
  pickle: messages.Pickle
  retries?: number
  skip?: boolean
  supportCodeLibrary: SupportCodeLibrary
}): Promise<{
  envelopes: messages.Envelope[]
  result: messages.TestStepResultStatus
}> {
  const envelopes: Envelope[] = []
  const eventBroadcaster = new EventEmitter()
  const newId = IdGenerator.incrementing()
  const testCase = (
    await assembleTestCases(
      newId(),
      eventBroadcaster,
      newId,
      [
        {
          gherkinDocument: options.gherkinDocument,
          pickle: options.pickle,
        },
      ],
      options.supportCodeLibrary
    )
  )[0].testCase

  // listen for envelopers _after_ we've assembled test cases
  eventBroadcaster.on('envelope', (e) => envelopes.push(e))
  const runner = new TestCaseRunner({
    workerId: options.workerId,
    eventBroadcaster,
    gherkinDocument: options.gherkinDocument,
    newId,
    pickle: options.pickle,
    testCase,
    retries: valueOrDefault(options.retries, 0),
    filterStackTraces: false,
    skip: valueOrDefault(options.skip, false),
    supportCodeLibrary: options.supportCodeLibrary,
    worldParameters: {},
  })
  const result = await runner.run()
  return { envelopes, result }
}

function predictableTimestamp(counter: number): messages.Timestamp {
  return {
    nanos: 1000000 * counter,
    seconds: 0,
  }
}

describe('TestCaseRunner', () => {
  let clock: InstalledClock

  beforeEach(() => {
    clock = FakeTimers.withGlobal(timeMethods).install()
  })

  afterEach(() => {
    clock.uninstall()
  })

  describe('run()', () => {
    describe('with a passing step', () => {
      it('emits testCase / testCaseStarted / testStepStarted / testStepFinished / testCaseFinished envelopes and returns the result', async () => {
        // Arrange
        const supportCodeLibrary = buildSupportCodeLibrary(({ Given }) => {
          Given('a step', function () {
            clock.tick(1)
          })
        })
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })
        const passedTestResult: messages.TestStepResult = {
          duration: messages.TimeConversion.millisecondsToDuration(1),
          status: messages.TestStepResultStatus.PASSED,
        }

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          supportCodeLibrary,
        })

        // Assert
        const expectedEnvelopes: messages.Envelope[] = [
          {
            testCaseStarted: {
              attempt: 0,
              id: '3',
              testCaseId: '1',
              timestamp: predictableTimestamp(0),
            },
          },
          {
            testStepStarted: {
              testCaseStartedId: '3',
              testStepId: '2',
              timestamp: predictableTimestamp(0),
            },
          },
          {
            testStepFinished: {
              testCaseStartedId: '3',
              testStepResult: passedTestResult,
              testStepId: '2',
              timestamp: predictableTimestamp(1),
            },
          },
          {
            testCaseFinished: {
              testCaseStartedId: '3',
              timestamp: predictableTimestamp(1),
              willBeRetried: false,
            },
          },
        ]
        expect(envelopes).to.eql(expectedEnvelopes)
        expect(result).to.eql(messages.TestStepResultStatus.PASSED)
      })
    })

    describe('with a failing step', () => {
      it('emits and returns failing results', async () => {
        // Arrange
        const supportCodeLibrary = buildSupportCodeLibrary(({ Given }) => {
          Given('a step', function () {
            throw 'fail'
          })
        })
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })
        const failingTestResult: messages.TestStepResult = {
          duration: messages.TimeConversion.millisecondsToDuration(0),
          status: messages.TestStepResultStatus.FAILED,
          message: 'fail',
          exception: {
            type: 'Error',
            message: 'fail',
            stackTrace: undefined,
          },
        }

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          supportCodeLibrary,
        })

        // Assert
        expect(envelopes).to.have.lengthOf(4)
        expect(envelopes[2].testStepFinished.testStepResult).to.eql(
          failingTestResult
        )
        expect(result).to.eql(messages.TestStepResultStatus.FAILED)
      })

      it('should provide the error to AfterStep and After hooks', async () => {
        // Arrange
        const error = new Error('fail')
        const afterStepStub = sinon.stub()
        const afterStub = sinon.stub()
        const supportCodeLibrary = buildSupportCodeLibrary(
          ({ Given, AfterStep, After }) => {
            Given('a step', function () {
              throw error
            })
            AfterStep(afterStepStub)
            After(afterStub)
          }
        )
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })

        // Act
        await testRunner({
          gherkinDocument,
          pickle,
          supportCodeLibrary,
        })

        // Assert
        expect(afterStepStub).to.have.been.calledOnce()
        expect(afterStepStub.lastCall.firstArg.error).to.eq(error)
        expect(afterStub).to.have.been.calledOnce()
        expect(afterStub.lastCall.firstArg.error).to.eq(error)
      })
    })

    describe('with an ambiguous step', () => {
      it('emits the expected envelopes and returns an ambiguous result', async () => {
        // Arrange
        const supportCodeLibrary = getBaseSupportCodeLibrary()
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given an ambiguous step'].join(
            '\n'
          ),
          uri: 'a.feature',
        })
        const message = [
          'Multiple step definitions match:',
          '  an ambiguous step    - steps.ts:13',
          '  /an? ambiguous step/ - steps.ts:14',
        ].join('\n')

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          supportCodeLibrary,
        })

        // Assert
        expect(envelopes).to.have.lengthOf(4)
        const expected: messages.TestStepResult = {
          message,
          status: messages.TestStepResultStatus.AMBIGUOUS,
          duration: messages.TimeConversion.millisecondsToDuration(0),
        }
        expect(envelopes[2].testStepFinished.testStepResult).to.eql(expected)
        expect(result).to.eql(
          envelopes[2].testStepFinished.testStepResult.status
        )
      })
    })

    describe('with a undefined step', () => {
      it('emits the expected envelopes and returns a undefined result', async () => {
        // Arrange
        const supportCodeLibrary = buildSupportCodeLibrary()
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          supportCodeLibrary,
        })

        // Assert
        expect(envelopes).to.have.lengthOf(4)
        const expected: messages.TestStepResult = {
          status: messages.TestStepResultStatus.UNDEFINED,
          duration: messages.TimeConversion.millisecondsToDuration(0),
        }
        expect(envelopes[2].testStepFinished.testStepResult).to.eql(expected)
        expect(result).to.eql(
          envelopes[2].testStepFinished.testStepResult.status
        )
      })
    })

    describe('with a flaky step and a positive retries value', () => {
      it('emits the expected envelopes and returns a passing result', async () => {
        // Arrange
        const supportCodeLibrary = buildSupportCodeLibrary(({ Given }) => {
          let willPass = false
          Given('a step', function () {
            clock.tick(1)
            if (willPass) {
              return
            }
            willPass = true
            throw 'Oh no!'
          })
        })
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          retries: 1,
          supportCodeLibrary,
        })

        // Assert
        const expected: messages.Envelope[] = [
          {
            testCaseStarted: {
              attempt: 0,
              id: '3',
              testCaseId: '1',
              timestamp: predictableTimestamp(0),
            },
          },
          {
            testStepStarted: {
              testCaseStartedId: '3',
              testStepId: '2',
              timestamp: predictableTimestamp(0),
            },
          },
          {
            testStepFinished: {
              testCaseStartedId: '3',
              testStepResult: {
                duration: messages.TimeConversion.millisecondsToDuration(1),
                message: 'Oh no!',
                exception: {
                  type: 'Error',
                  message: 'Oh no!',
                  stackTrace: undefined,
                },
                status: messages.TestStepResultStatus.FAILED,
              },
              testStepId: '2',
              timestamp: predictableTimestamp(1),
            },
          },
          {
            testCaseFinished: {
              testCaseStartedId: '3',
              timestamp: predictableTimestamp(1),
              willBeRetried: true,
            },
          },
          {
            testCaseStarted: {
              attempt: 1,
              id: '4',
              testCaseId: '1',
              timestamp: predictableTimestamp(1),
            },
          },
          {
            testStepStarted: {
              testCaseStartedId: '4',
              testStepId: '2',
              timestamp: predictableTimestamp(1),
            },
          },
          {
            testStepFinished: {
              testCaseStartedId: '4',
              testStepResult: {
                duration: messages.TimeConversion.millisecondsToDuration(1),
                status: messages.TestStepResultStatus.PASSED,
              },
              testStepId: '2',
              timestamp: predictableTimestamp(2),
            },
          },
          {
            testCaseFinished: {
              testCaseStartedId: '4',
              timestamp: predictableTimestamp(2),
              willBeRetried: false,
            },
          },
        ]
        expect(envelopes).to.eql(expected)
        expect(result).to.eql(messages.TestStepResultStatus.PASSED)
      })

      it('should provide the correctly willBeRetried value to the hook', async () => {
        // Arrange
        const hookStub = sinon.stub()
        const supportCodeLibrary = buildSupportCodeLibrary(
          ({ Given, After }) => {
            let willPass = false
            Given('a step', function () {
              if (willPass) {
                return
              }
              willPass = true
              throw 'error'
            })
            After(hookStub)
          }
        )
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })

        // Act
        await testRunner({
          gherkinDocument,
          pickle,
          retries: 1,
          supportCodeLibrary,
        })

        // Assert
        expect(hookStub).to.have.been.calledTwice()
        expect(hookStub.args[0][0].willBeRetried).to.eq(true)
        expect(hookStub.args[1][0].willBeRetried).to.eq(false)
      })
    })

    describe('with a step when skipping', () => {
      it('emits the expected envelopes and returns a skipped result', async () => {
        // Arrange
        const supportCodeLibrary = buildSupportCodeLibrary(({ Given }) => {
          Given('a step', function () {
            clock.tick(1)
          })
        })
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          skip: true,
          supportCodeLibrary,
        })

        // Assert
        expect(envelopes).to.have.lengthOf(4)
        const expected: messages.TestStepResult = {
          status: messages.TestStepResultStatus.SKIPPED,
          duration: messages.TimeConversion.millisecondsToDuration(0),
        }
        expect(envelopes[2].testStepFinished.testStepResult).to.eql(expected)
        expect(result).to.eql(
          envelopes[2].testStepFinished.testStepResult.status
        )
      })
    })

    describe('with test case hooks', () => {
      it('emits the expected envelopes and returns a skipped result', async () => {
        // Arrange
        const supportCodeLibrary = buildSupportCodeLibrary(
          ({ Given, Before, After }) => {
            Given('a step', function () {
              clock.tick(1)
            })
            Before(function () {})
            After(function () {})
          }
        )
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          supportCodeLibrary,
        })

        // Assert
        expect(envelopes).to.have.lengthOf(8)
        expect(result).to.eql(
          envelopes[6].testStepFinished.testStepResult.status
        )
      })
    })

    describe('with step hooks', () => {
      it('emits the expected envelopes and returns a skipped result', async () => {
        const beforeStep = sinon.stub()
        const afterStep = sinon.stub()

        // Arrange
        const supportCodeLibrary = buildSupportCodeLibrary(
          ({ Given, BeforeStep, AfterStep }) => {
            Given('a step', function () {
              clock.tick(1)
            })
            BeforeStep(beforeStep)
            AfterStep(afterStep)
          }
        )
        const {
          gherkinDocument,
          pickles: [pickle],
        } = await parse({
          data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
          uri: 'a.feature',
        })

        // Act
        const { envelopes, result } = await testRunner({
          gherkinDocument,
          pickle,
          supportCodeLibrary,
        })

        // Assert
        expect(envelopes).to.have.lengthOf(4)
        expect(result).to.eql(
          envelopes[2].testStepFinished.testStepResult.status
        )
        expect(beforeStep).to.have.been.calledOnceWith({
          gherkinDocument,
          pickle,
          pickleStep: pickle.steps[0],
          testCaseStartedId: envelopes[1].testStepStarted.testCaseStartedId,
          testStepId: envelopes[1].testStepStarted.testStepId,
          result: undefined,
          error: undefined,
        })
        expect(afterStep).to.have.been.calledOnceWith({
          gherkinDocument,
          pickle,
          pickleStep: pickle.steps[0],
          testCaseStartedId: envelopes[2].testStepFinished.testCaseStartedId,
          testStepId: envelopes[2].testStepFinished.testStepId,
          result: envelopes[2].testStepFinished.testStepResult,
          error: undefined,
        })
      })
    })

    it('emits workerId on testCaseStarted when provided', async () => {
      // Arrange
      const supportCodeLibrary = buildSupportCodeLibrary(({ Given }) => {
        Given('a step', function () {
          clock.tick(1)
        })
      })
      const {
        gherkinDocument,
        pickles: [pickle],
      } = await parse({
        data: ['Feature: a', 'Scenario: b', 'Given a step'].join('\n'),
        uri: 'a.feature',
      })

      // Act
      const { envelopes } = await testRunner({
        workerId: 'foo',
        gherkinDocument,
        pickle,
        supportCodeLibrary,
      })

      // Assert
      expect(envelopes).to.deep.include({
        testCaseStarted: {
          workerId: 'foo',
          attempt: 0,
          id: '3',
          testCaseId: '1',
          timestamp: predictableTimestamp(0),
        },
      })
    })
  })
})
