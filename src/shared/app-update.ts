export type AppUpdateMode = 'installer' | 'portable' | 'manual' | 'development'
export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface AppRelease {
  version: string
  notes: string
  publishedAt?: string
}

export interface AppUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface AppUpdateState {
  revision: number
  mode: AppUpdateMode
  status: AppUpdateStatus
  currentVersion: string
  release: AppRelease | null
  progress: AppUpdateProgress | null
  checkedAt: string | null
  error: string | null
}
