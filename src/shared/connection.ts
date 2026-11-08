export interface ConnectionStatus {
  executable: string | null
  source: 'custom' | 'installed' | 'bundled' | null
  version: string | null
  configDirectory: string | null
  loggedIn: boolean
  authMethod: string | null
  provider: string | null
  error: string | null
}
