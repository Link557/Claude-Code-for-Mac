import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeMetadataQueries, readMetadata } from '../src/main/metadataQuery'
const sdk = vi.hoisted(()=>({query:vi.fn(), load:vi.fn()}))
vi.mock('../src/main/sdk',()=>({loadSdk:()=>sdk.load(),claudeExecutable:()=>'/custom/claude'}))
beforeEach(()=>{vi.clearAllMocks();sdk.load.mockResolvedValue(sdk)})
afterEach(()=>{closeMetadataQueries();vi.useRealTimers()})
it('returns initialization without consuming or draining a model stream and closes the query', async()=>{
  const close=vi.fn(), iterator=vi.fn()
  sdk.query.mockReturnValue({initializationResult:async()=>({commands:[],models:[]}),request:async()=>({response:{effective:{},sources:[]}}),close,[Symbol.asyncIterator]:iterator})
  await expect(readMetadata('/a')).resolves.toEqual({commands:[],models:[]})
  expect(iterator).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(1)
  const request=sdk.query.mock.calls[0][0]
  expect(request.options).toMatchObject({cwd:'/a',persistSession:false,pathToClaudeCodeExecutable:'/custom/claude'})
  expect(await request.prompt[Symbol.asyncIterator]().next()).toEqual({done:true,value:undefined})
})
it('closes a hanging initialization on timeout',async()=>{
  vi.useFakeTimers();const close=vi.fn()
  sdk.query.mockReturnValue({initializationResult:()=>new Promise(()=>{}),close})
  const task=readMetadata('/a');const checked=expect(task).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(15000);await checked;expect(close).toHaveBeenCalledTimes(1)
})
it('application shutdown cancels metadata initialization even when SDK loading is still pending',async()=>{
  let done!: (sdk:unknown)=>void
  sdk.load.mockImplementation(()=>new Promise(resolve=>{done=resolve}))
  const task=readMetadata('/a');const checked=expect(task).rejects.toThrow('取消')
  closeMetadataQueries();await checked;done(sdk);await Promise.resolve()
  expect(sdk.query).not.toHaveBeenCalled()
})
it('cancels an active query when its owner aborts',async()=>{
  const close=vi.fn(), controller=new AbortController()
  sdk.query.mockReturnValue({initializationResult:()=>new Promise(()=>{}),close})
  const task=readMetadata('/a',controller.signal);const checked=expect(task).rejects.toThrow('取消')
  await vi.waitFor(()=>expect(sdk.query).toHaveBeenCalledOnce());controller.abort();await checked
  expect(close).toHaveBeenCalledOnce()
})
