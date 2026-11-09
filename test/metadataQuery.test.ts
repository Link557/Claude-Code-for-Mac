import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeMetadataQueries, readMetadata } from '../src/main/metadataQuery'
const sdk = vi.hoisted(()=>({query:vi.fn(), load:vi.fn()}))
const api = vi.hoisted(() => ({ fetch: vi.fn(), env: {} as Record<string, string> }))
vi.mock('electron', () => ({ net: { fetch: api.fetch } }))
vi.mock('../src/main/sdk',()=>({loadSdk:()=>sdk.load(),claudeExecutable:()=>'/custom/claude'}))
vi.mock('../src/main/claudeConfigProtocol',()=>({readConfigState:async()=>({effective:{ env: api.env }}),isConfigRecord:(v:unknown)=>!!v && typeof v==='object' && !Array.isArray(v)}))
beforeEach(()=>{vi.clearAllMocks();sdk.load.mockResolvedValue(sdk);api.env = {}})
afterEach(()=>{closeMetadataQueries();vi.useRealTimers()})
it('returns initialization without consuming or draining a model stream and closes the query', async()=>{
  const close=vi.fn(), iterator=vi.fn()
  sdk.query.mockReturnValue({initializationResult:async()=>({commands:[]}),close,[Symbol.asyncIterator]:iterator})
  await expect(readMetadata('/a')).resolves.toEqual({commands:[]})
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

it('uses only the configured endpoint models across pages, with exact IDs and reported effort', async () => {
  api.env = { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic/', ANTHROPIC_AUTH_TOKEN: 'test-token' }
  sdk.query.mockReturnValue({
    initializationResult: async () => ({ commands: [], models: [
      { value: 'default' }, { value: 'fable', resolvedModel: 'claude-fable-5' },
      { value: 'sonnet', resolvedModel: 'vendor/custom' }
    ] }),
    close: vi.fn()
  })
  api.fetch.mockResolvedValueOnce(Response.json({
    data: [{ id: 'vendor/custom', display_name: 'Custom', capabilities: { effort: { supported: true, high: { supported: true } } } }],
    has_more: true,
    last_id: 'vendor/custom'
  })).mockResolvedValueOnce(Response.json({ data: [{ id: 'other' }, { id: 'other' }] }))
  const result = await readMetadata('/a', undefined, true)
  expect(result.models.map(model => [model.value, model.resolvedModel, model.displayName, model.supportedEffortLevels])).toEqual([
    ['default', undefined, '默认模型', undefined], ['sonnet', 'vendor/custom', 'Sonnet', ['high']], ['other', 'other', 'other', []]
  ])
  expect(api.fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://gateway.example/anthropic/v1/models',
    'https://gateway.example/anthropic/v1/models?after_id=vendor%2Fcustom'
  ])
  expect(api.fetch.mock.calls[0][1].headers.get('authorization')).toBe('Bearer test-token')
})

it('reports a failed model API without falling back to the CLI catalog or exposing the response body', async () => {
  api.env = { ANTHROPIC_BASE_URL: 'https://gateway.example' }
  sdk.query.mockReturnValue({
    initializationResult: async () => ({ commands: [{ name: 'context' }], models: [{ value: 'opus' }] }),
    close: vi.fn()
  })
  api.fetch.mockResolvedValueOnce(new Response('private gateway details', { status: 403 }))
  await expect(readMetadata('/a', undefined, true)).resolves.toMatchObject({
    commands: [{ name: 'context' }],
    models: [],
    modelCatalogError: '模型列表接口返回 HTTP 403。'
  })
})

it('shows one current mapping per family for a Claude.ai login without model API credentials', async () => {
  api.env = { ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_CUSTOM_HEADERS: '' }
  sdk.query.mockReturnValue({
    initializationResult: async () => ({ account: { apiProvider: 'firstParty', tokenSource: 'claude.ai' }, models: [
      { value: 'default', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' }
    ] }),
    close: vi.fn()
  })
  await expect(readMetadata('/a', undefined, true)).resolves.toMatchObject({
    models: [
      { value: 'default', resolvedModel: 'claude-opus-5-5' },
      { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' }
    ]
  })
  expect(api.fetch).not.toHaveBeenCalled()
})

it('uses the configured Fable mapping and gateway capabilities when the CLI reports a stale alias', async () => {
  api.env = { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_DEFAULT_FABLE_MODEL: 'vendor/fable' }
  sdk.query.mockReturnValue({
    initializationResult: async () => ({ models: [
      { value: 'default', resolvedModel: 'vendor/fable', displayName: 'Default' },
      { value: 'fable', resolvedModel: 'claude-fable-old', supportsEffort: true, supportedEffortLevels: ['max'] }
    ] }),
    close: vi.fn()
  })
  api.fetch.mockResolvedValueOnce(Response.json({ data: [
    { id: 'vendor/fable', capabilities: { effort: { supported: true, low: { supported: true } } } }
  ] }))
  const result = await readMetadata('/a', undefined, true)
  expect(result.models).toMatchObject([
    { value: 'default', resolvedModel: 'vendor/fable', supportedEffortLevels: ['low'] },
    { value: 'fable', resolvedModel: 'vendor/fable', supportedEffortLevels: ['low'] }
  ])
})
