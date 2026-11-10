export interface ConnectionStatus {
  state: 'missing' | 'invalidPath' | 'unusable' | 'ready'
  executable: string | null
  source: 'custom' | 'installed' | 'bundled' | null
  version: string | null
  configDirectory: string | null
  /** null means that the CLI authentication status could not be confirmed. */
  loggedIn: boolean | null
  authMethod: string | null
  provider: string | null
  error: string | null
}

export interface CliInstallProgress {
  stage: 'checking' | 'manifest' | 'downloading' | 'verifying' | 'installing' | 'version' | 'complete'
  percent?: number
}
